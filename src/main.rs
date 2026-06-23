#![no_std]
#![no_main]

#[cfg(not(any(feature = "acm-bridge", feature = "tcp-bridge")))]
compile_error!("enable one bridge feature: `acm-bridge` or `tcp-bridge`");

use panic_halt as _;

#[cfg(feature = "tcp-bridge")]
use ch32_hal::eth::{self, Ethernet, GenericPhy, PacketQueue, PhyInterface};
#[cfg(feature = "acm-bridge")]
use ch32_hal::otg_fs;
use ch32_hal::usb::EndpointDataBuffer512;
use ch32_hal::usbhs::{self, Driver as UsbHsDriver};
use ch32_hal::{self as hal, bind_interrupts, peripherals, Config};
use embassy_executor::Spawner;
use embassy_futures::join::join;
#[cfg(feature = "tcp-bridge")]
use embassy_futures::select::select;
#[cfg(feature = "tcp-bridge")]
use embassy_net::tcp::{TcpReader, TcpSocket, TcpWriter};
#[cfg(feature = "tcp-bridge")]
use embassy_net::StackResources;
use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::channel::{Channel, Receiver, Sender};
#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
use embassy_sync::pubsub::{PubSubChannel, Subscriber};
#[cfg(feature = "acm-bridge")]
use embassy_usb::class::cdc_acm::{
    CdcAcmClass, Receiver as CdcReceiver, Sender as CdcSender, State as CdcState,
};
use embassy_usb::driver::EndpointError;
use embassy_usb::Builder;
#[cfg(feature = "tcp-bridge")]
use embedded_io_async::Write;
#[cfg(feature = "tcp-bridge")]
use static_cell::StaticCell;

mod ehci_debug;

use ehci_debug::{
    DebugIn, DebugOut, EhciDebugClass, State as EhciDebugState, DEBUG_ENDPOINT_MAX_PACKET_SIZE,
    DEBUG_TRANSACTION_SIZE,
};

const VID: u16 = 0x1209;
const PID_DEBUG: u16 = 0x000d;
#[cfg(feature = "acm-bridge")]
const PID_ACM: u16 = 0x000e;

#[cfg(feature = "acm-bridge")]
const ACM_PACKET_SIZE: usize = 64;
#[cfg(feature = "acm-bridge")]
const ACM_TX_PACKET_SIZE: usize = 63;
#[cfg(feature = "acm-bridge")]
const ACM_ENDPOINT_BUFFER_COUNT: usize = 4;
#[cfg(feature = "tcp-bridge")]
const TCP_PORT: u16 = 3333;
#[cfg(feature = "tcp-bridge")]
const TCP_BUFFER_SIZE: usize = 1536;
#[cfg(feature = "tcp-bridge")]
const TCP_IO_CHUNK: usize = 1024;
const QUEUE_DEPTH: usize = 4096;

type ByteChannel = Channel<NoopRawMutex, u8, QUEUE_DEPTH>;
type ByteSender<'a> = Sender<'a, NoopRawMutex, u8, QUEUE_DEPTH>;
type ByteReceiver<'a> = Receiver<'a, NoopRawMutex, u8, QUEUE_DEPTH>;
#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
type DutOutputPubSub = PubSubChannel<NoopRawMutex, u8, QUEUE_DEPTH, 2, 1>;
#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
type DutOutputSubscriber<'a> = Subscriber<'a, NoopRawMutex, u8, QUEUE_DEPTH, 2, 1>;

#[cfg(feature = "tcp-bridge")]
type NetDevice = Ethernet<'static, 4, 4, GenericPhy>;

#[cfg(feature = "acm-bridge")]
type UsbFsDriver<'d> = otg_fs::Driver<'d, peripherals::OTG_FS, ACM_ENDPOINT_BUFFER_COUNT, 512>;
#[cfg(feature = "acm-bridge")]
type AcmCdcSender<'d> = CdcSender<'d, UsbFsDriver<'d>>;
#[cfg(feature = "acm-bridge")]
type AcmCdcReceiver<'d> = CdcReceiver<'d, UsbFsDriver<'d>>;

#[cfg(feature = "acm-bridge")]
struct AcmUsbResources<'d> {
    ep_buffers: [EndpointDataBuffer512; ACM_ENDPOINT_BUFFER_COUNT],
    config_descriptor: [u8; 256],
    bos_descriptor: [u8; 64],
    msos_descriptor: [u8; 64],
    control_buf: [u8; 64],
    cdc_state: CdcState<'d>,
}

#[cfg(feature = "acm-bridge")]
impl<'d> AcmUsbResources<'d> {
    fn new() -> Self {
        Self {
            ep_buffers: core::array::from_fn(|_| EndpointDataBuffer512::default()),
            config_descriptor: [0; 256],
            bos_descriptor: [0; 64],
            msos_descriptor: [0; 64],
            control_buf: [0; 64],
            cdc_state: CdcState::new(),
        }
    }
}

#[cfg(feature = "acm-bridge")]
struct AcmUsb<'d> {
    device: embassy_usb::UsbDevice<'d, UsbFsDriver<'d>>,
    sender: AcmCdcSender<'d>,
    receiver: AcmCdcReceiver<'d>,
}

bind_interrupts!(struct UsbHsIrqs {
    USBHS => usbhs::InterruptHandler<peripherals::USBHS>;
    USBHS_WKUP => usbhs::WakeupInterruptHandler<peripherals::USBHS>;
});

#[cfg(feature = "acm-bridge")]
bind_interrupts!(struct UsbFsIrqs {
    OTG_FS => otg_fs::InterruptHandler<peripherals::OTG_FS>;
});

#[cfg(feature = "tcp-bridge")]
#[hal::interrupt]
unsafe fn ETH() {
    eth::on_interrupt();
}

#[embassy_executor::main(entry = "qingke_rt::entry")]
async fn main(_spawner: Spawner) -> ! {
    let cfg = Config {
        // Match the USBHS example clock tree: this preset assumes an 8 MHz HSE,
        // derives 144 MHz SYSCLK, 48 MHz USB FS, and the USBHS PLL reference.
        rcc: ch32_hal::rcc::Config::SYSCLK_FREQ_144MHZ_HSE,
        ..Default::default()
    };
    let p = hal::init(cfg);

    let mut hs_ep_buffers: [EndpointDataBuffer512; 3] =
        core::array::from_fn(|_| EndpointDataBuffer512::default());
    let hs_driver = UsbHsDriver::new(p.USBHS, UsbHsIrqs, p.PB7, p.PB6, &mut hs_ep_buffers);
    let mut hs_config = embassy_usb::Config::new(VID, PID_DEBUG);
    hs_config.manufacturer = Some("Arthur Heymans");
    hs_config.product = Some("CH32V307 EHCI debug device");
    hs_config.serial_number = Some("ehci-debug");
    hs_config.max_power = 100;
    hs_config.max_packet_size_0 = 64;
    hs_config.device_class = 0xff;
    hs_config.device_sub_class = 0;
    hs_config.device_protocol = 0;
    hs_config.composite_with_iads = false;

    let mut hs_config_descriptor = [0; 128];
    let mut hs_bos_descriptor = [0; 64];
    let mut hs_msos_descriptor = [0; 64];
    let mut hs_control_buf = [0; 64];
    let mut ehci_state = EhciDebugState::new();
    let mut hs_builder = Builder::new(
        hs_driver,
        hs_config,
        &mut hs_config_descriptor,
        &mut hs_bos_descriptor,
        &mut hs_msos_descriptor,
        &mut hs_control_buf,
    );
    let ehci = EhciDebugClass::new(&mut hs_builder, &mut ehci_state);
    let mut hs_usb = hs_builder.build();
    let (debug_out, debug_in) = ehci.split();

    #[cfg(all(feature = "acm-bridge", not(feature = "tcp-bridge")))]
    {
        let bridge = acm_bridge(p.OTG_FS, p.PA12, p.PA11, debug_out, debug_in);
        join(hs_usb.run(), bridge).await;
    }

    #[cfg(all(feature = "tcp-bridge", not(feature = "acm-bridge")))]
    {
        let (stack, mut runner) = setup_network_stack();
        let bridge = tcp_bridge(stack, debug_out, debug_in);
        join(hs_usb.run(), join(runner.run(), bridge)).await;
    }

    #[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
    {
        let (stack, mut runner) = setup_network_stack();
        let bridge = acm_tcp_bridge(p.OTG_FS, p.PA12, p.PA11, stack, debug_out, debug_in);
        join(hs_usb.run(), join(runner.run(), bridge)).await;
    }

    loop {}
}

#[cfg(all(feature = "acm-bridge", not(feature = "tcp-bridge")))]
async fn acm_bridge<'d, D>(
    otg_fs: ch32_hal::Peri<'d, peripherals::OTG_FS>,
    dp: ch32_hal::Peri<'d, peripherals::PA12>,
    dm: ch32_hal::Peri<'d, peripherals::PA11>,
    debug_out: DebugOut<'d, D>,
    debug_in: DebugIn<'d, D>,
) where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut acm_resources = AcmUsbResources::new();
    let AcmUsb {
        device: mut fs_usb,
        sender: cdc_sender,
        receiver: cdc_receiver,
    } = setup_acm(otg_fs, dp, dm, &mut acm_resources);

    let dut_to_acm = ByteChannel::new();
    let acm_to_dut = ByteChannel::new();

    let usb_task = fs_usb.run();
    let bridge_tasks = join(
        join(
            dut_to_bridge_task(debug_out, dut_to_acm.sender()),
            bridge_to_dut_task(debug_in, acm_to_dut.receiver()),
        ),
        join(
            acm_tx_task(cdc_sender, dut_to_acm.receiver()),
            acm_rx_task(cdc_receiver, acm_to_dut.sender()),
        ),
    );

    join(usb_task, bridge_tasks).await;
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn acm_tcp_bridge<'d, D>(
    otg_fs: ch32_hal::Peri<'d, peripherals::OTG_FS>,
    dp: ch32_hal::Peri<'d, peripherals::PA12>,
    dm: ch32_hal::Peri<'d, peripherals::PA11>,
    stack: embassy_net::Stack<'static>,
    debug_out: DebugOut<'d, D>,
    debug_in: DebugIn<'d, D>,
) where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut acm_resources = AcmUsbResources::new();
    let AcmUsb {
        device: mut fs_usb,
        sender: cdc_sender,
        receiver: cdc_receiver,
    } = setup_acm(otg_fs, dp, dm, &mut acm_resources);

    let dut_output = DutOutputPubSub::new();
    let mut dut_to_acm = match dut_output.subscriber() {
        Ok(subscriber) => subscriber,
        Err(_) => loop {},
    };
    let mut dut_to_tcp = match dut_output.subscriber() {
        Ok(subscriber) => subscriber,
        Err(_) => loop {},
    };
    let to_dut = ByteChannel::new();

    let usb_task = fs_usb.run();
    let bridge_tasks = join(
        join(
            dut_to_pubsub_task(debug_out, &dut_output),
            bridge_to_dut_task(debug_in, to_dut.receiver()),
        ),
        join(
            join(
                acm_pubsub_tx_task(cdc_sender, &mut dut_to_acm),
                acm_rx_task(cdc_receiver, to_dut.sender()),
            ),
            tcp_server_pubsub_task(stack, &mut dut_to_tcp, to_dut.sender()),
        ),
    );

    join(usb_task, bridge_tasks).await;
}

#[cfg(feature = "acm-bridge")]
fn setup_acm<'d>(
    otg_fs: ch32_hal::Peri<'d, peripherals::OTG_FS>,
    dp: ch32_hal::Peri<'d, peripherals::PA12>,
    dm: ch32_hal::Peri<'d, peripherals::PA11>,
    resources: &'d mut AcmUsbResources<'d>,
) -> AcmUsb<'d> {
    // CDC ACM allocates interrupt IN, bulk OUT, bulk IN, and then EP0 when the
    // USB device starts. The pull-up is enabled before EP0 allocation in the
    // current HAL, so too few buffers makes Linux see a device that never
    // answers setup packets.
    let fs_driver = otg_fs::Driver::new(otg_fs, dp, dm, &mut resources.ep_buffers);
    let mut fs_config = embassy_usb::Config::new(VID, PID_ACM);
    fs_config.manufacturer = Some("Arthur Heymans");
    fs_config.product = Some("CH32V307 EHCI debug ACM bridge");
    fs_config.serial_number = Some("ehci-acm");
    fs_config.max_power = 100;
    fs_config.max_packet_size_0 = 64;
    fs_config.device_class = 0x02;
    fs_config.device_sub_class = 0x02;
    fs_config.device_protocol = 0x00;
    fs_config.composite_with_iads = false;

    let mut fs_builder = Builder::new(
        fs_driver,
        fs_config,
        &mut resources.config_descriptor,
        &mut resources.bos_descriptor,
        &mut resources.msos_descriptor,
        &mut resources.control_buf,
    );
    let cdc = CdcAcmClass::new(
        &mut fs_builder,
        &mut resources.cdc_state,
        ACM_PACKET_SIZE as u16,
    );
    let device = fs_builder.build();
    let (sender, receiver) = cdc.split();

    AcmUsb {
        device,
        sender,
        receiver,
    }
}

#[cfg(feature = "tcp-bridge")]
fn setup_network_stack() -> (
    embassy_net::Stack<'static>,
    embassy_net::Runner<'static, NetDevice>,
) {
    let mac_addr = [0x02, 0xcb, 0x00, 0x12, 0x34, 0x57];

    static QUEUE: StaticCell<PacketQueue<4, 4>> = StaticCell::new();
    let queue = QUEUE.init(PacketQueue::new());
    let phy = GenericPhy::new(1);
    let device = Ethernet::new(queue, mac_addr, phy, PhyInterface::Internal10M, 144);

    static RESOURCES: StaticCell<StackResources<3>> = StaticCell::new();
    embassy_net::new(
        device,
        embassy_net::Config::dhcpv4(Default::default()),
        RESOURCES.init(StackResources::new()),
        0x1234_5678_9abc_def0,
    )
}

#[cfg(all(feature = "tcp-bridge", not(feature = "acm-bridge")))]
async fn tcp_bridge<'d, D>(
    stack: embassy_net::Stack<'static>,
    debug_out: DebugOut<'d, D>,
    debug_in: DebugIn<'d, D>,
) where
    D: embassy_usb::driver::Driver<'d>,
{
    let dut_to_tcp = ByteChannel::new();
    let tcp_to_dut = ByteChannel::new();

    let bridge_tasks = join(
        dut_to_bridge_task(debug_out, dut_to_tcp.sender()),
        bridge_to_dut_task(debug_in, tcp_to_dut.receiver()),
    );
    let tcp_task = tcp_server_task(stack, dut_to_tcp.receiver(), tcp_to_dut.sender());

    join(bridge_tasks, tcp_task).await;
}

#[cfg(not(all(feature = "acm-bridge", feature = "tcp-bridge")))]
async fn dut_to_bridge_task<'d, D>(mut debug_out: DebugOut<'d, D>, bridge_tx: ByteSender<'_>)
where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut buf = [0; DEBUG_ENDPOINT_MAX_PACKET_SIZE];

    loop {
        debug_out.wait_enabled().await;
        while let Ok(n) = debug_out.read_packet(&mut buf).await {
            for &byte in &buf[..n] {
                bridge_tx.send(byte).await;
            }
        }
    }
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn dut_to_pubsub_task<'d, D>(mut debug_out: DebugOut<'d, D>, output: &DutOutputPubSub)
where
    D: embassy_usb::driver::Driver<'d>,
{
    let publisher = output.immediate_publisher();
    let mut buf = [0; DEBUG_ENDPOINT_MAX_PACKET_SIZE];

    loop {
        debug_out.wait_enabled().await;
        while let Ok(n) = debug_out.read_packet(&mut buf).await {
            for &byte in &buf[..n] {
                publisher.publish_immediate(byte);
            }
        }
    }
}

async fn bridge_to_dut_task<'d, D>(mut debug_in: DebugIn<'d, D>, dut_rx: ByteReceiver<'_>)
where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut buf = [0; DEBUG_TRANSACTION_SIZE];

    loop {
        debug_in.wait_enabled().await;
        let n = fill_packet(&dut_rx, &mut buf, DEBUG_TRANSACTION_SIZE).await;
        if matches!(
            debug_in.write_packet(&buf[..n]).await,
            Err(EndpointError::Disabled)
        ) {
            continue;
        }
    }
}

#[cfg(all(feature = "acm-bridge", not(feature = "tcp-bridge")))]
async fn acm_tx_task<'d, D>(mut cdc_sender: CdcSender<'d, D>, dut_rx: ByteReceiver<'_>)
where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut buf = [0; ACM_PACKET_SIZE];

    loop {
        cdc_sender.wait_connection().await;
        let n = fill_packet(&dut_rx, &mut buf, ACM_TX_PACKET_SIZE).await;
        if matches!(
            cdc_sender.write_packet(&buf[..n]).await,
            Err(EndpointError::Disabled)
        ) {
            continue;
        }
    }
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn acm_pubsub_tx_task<'d, D>(
    mut cdc_sender: CdcSender<'d, D>,
    dut_rx: &mut DutOutputSubscriber<'_>,
) where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut buf = [0; ACM_PACKET_SIZE];

    loop {
        cdc_sender.wait_connection().await;
        let n = fill_pubsub_packet(dut_rx, &mut buf, ACM_TX_PACKET_SIZE).await;
        if matches!(
            cdc_sender.write_packet(&buf[..n]).await,
            Err(EndpointError::Disabled)
        ) {
            continue;
        }
    }
}

#[cfg(feature = "acm-bridge")]
async fn acm_rx_task<'d, D>(mut cdc_receiver: CdcReceiver<'d, D>, dut_tx: ByteSender<'_>)
where
    D: embassy_usb::driver::Driver<'d>,
{
    let mut buf = [0; ACM_PACKET_SIZE];

    loop {
        cdc_receiver.wait_connection().await;
        while let Ok(n) = cdc_receiver.read_packet(&mut buf).await {
            for &byte in &buf[..n] {
                dut_tx.send(byte).await;
            }
        }
    }
}

#[cfg(all(feature = "tcp-bridge", not(feature = "acm-bridge")))]
async fn tcp_server_task(
    stack: embassy_net::Stack<'static>,
    dut_rx: ByteReceiver<'_>,
    dut_tx: ByteSender<'_>,
) -> ! {
    while !stack.is_link_up() {
        embassy_time::Timer::after_millis(100).await;
    }
    stack.wait_config_up().await;

    let mut rx_buffer = [0; TCP_BUFFER_SIZE];
    let mut tx_buffer = [0; TCP_BUFFER_SIZE];

    loop {
        let mut socket = TcpSocket::new(stack, &mut rx_buffer, &mut tx_buffer);
        if socket.accept(TCP_PORT).await.is_err() {
            embassy_time::Timer::after_millis(250).await;
            continue;
        }

        {
            let (reader, writer) = socket.split();
            let _ = select(
                tcp_client_rx_task(reader, dut_tx),
                tcp_client_tx_task(writer, dut_rx),
            )
            .await;
        }

        socket.abort();
    }
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn tcp_server_pubsub_task(
    stack: embassy_net::Stack<'static>,
    dut_rx: &mut DutOutputSubscriber<'_>,
    dut_tx: ByteSender<'_>,
) -> ! {
    while !stack.is_link_up() {
        embassy_time::Timer::after_millis(100).await;
    }
    stack.wait_config_up().await;

    let mut rx_buffer = [0; TCP_BUFFER_SIZE];
    let mut tx_buffer = [0; TCP_BUFFER_SIZE];

    loop {
        let mut socket = TcpSocket::new(stack, &mut rx_buffer, &mut tx_buffer);
        if socket.accept(TCP_PORT).await.is_err() {
            embassy_time::Timer::after_millis(250).await;
            continue;
        }

        {
            let (reader, writer) = socket.split();
            let _ = select(
                tcp_client_rx_task(reader, dut_tx),
                tcp_client_pubsub_tx_task(writer, dut_rx),
            )
            .await;
        }

        socket.abort();
    }
}

#[cfg(feature = "tcp-bridge")]
async fn tcp_client_rx_task(mut reader: TcpReader<'_>, dut_tx: ByteSender<'_>) {
    let mut buf = [0; TCP_IO_CHUNK];

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };

        for &byte in &buf[..n] {
            dut_tx.send(byte).await;
        }
    }
}

#[cfg(all(feature = "tcp-bridge", not(feature = "acm-bridge")))]
async fn tcp_client_tx_task(mut writer: TcpWriter<'_>, dut_rx: ByteReceiver<'_>) {
    let mut buf = [0; TCP_IO_CHUNK];

    loop {
        let n = fill_packet(&dut_rx, &mut buf, TCP_IO_CHUNK).await;
        if writer.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn tcp_client_pubsub_tx_task(
    mut writer: TcpWriter<'_>,
    dut_rx: &mut DutOutputSubscriber<'_>,
) {
    let mut buf = [0; TCP_IO_CHUNK];

    loop {
        let n = fill_pubsub_packet(dut_rx, &mut buf, TCP_IO_CHUNK).await;
        if writer.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}

async fn fill_packet<const N: usize>(
    rx: &ByteReceiver<'_>,
    buf: &mut [u8; N],
    max_len: usize,
) -> usize {
    let limit = core::cmp::min(max_len, N);
    buf[0] = rx.receive().await;
    let mut len = 1;

    while len < limit {
        match rx.try_receive() {
            Ok(byte) => {
                buf[len] = byte;
                len += 1;
            }
            Err(_) => break,
        }
    }

    len
}

#[cfg(all(feature = "acm-bridge", feature = "tcp-bridge"))]
async fn fill_pubsub_packet<const N: usize>(
    rx: &mut DutOutputSubscriber<'_>,
    buf: &mut [u8; N],
    max_len: usize,
) -> usize {
    let limit = core::cmp::min(max_len, N);
    buf[0] = rx.next_message_pure().await;
    let mut len = 1;

    while len < limit {
        match rx.try_next_message_pure() {
            Some(byte) => {
                buf[len] = byte;
                len += 1;
            }
            None => break,
        }
    }

    len
}
