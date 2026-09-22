//! USB 2.0 EHCI Debug Device class support.
//!
//! The EHCI debug port can only move up to eight payload bytes per debug
//! transaction.  The standard USB debug descriptor points coreboot at one bulk
//! IN endpoint and one bulk OUT endpoint; after `SET_FEATURE(DEBUG_MODE)` the
//! host uses those endpoints as the console pipes.

use embassy_usb::control::{InResponse, OutResponse, Recipient, Request, RequestType};
use embassy_usb::descriptor::{descriptor_type, SynchronizationType, UsageType};
use embassy_usb::driver::{
    Direction, Driver, Endpoint, EndpointAddress, EndpointIn, EndpointOut, EndpointType,
};
use embassy_usb::{Builder, Handler};

const DEBUG_DESCRIPTOR_LEN: usize = 4;

/// Maximum payload size of an EHCI debug-port transaction.
pub const DEBUG_TRANSACTION_SIZE: usize = 8;

/// USB 2.0 high-speed bulk endpoints must advertise 512-byte packets.
///
/// EHCI debug transactions still carry at most `DEBUG_TRANSACTION_SIZE` bytes;
/// this is only the descriptor/allocation size needed for a valid high-speed
/// bulk endpoint.
pub const DEBUG_ENDPOINT_MAX_PACKET_SIZE: usize = 512;

/// Holds control-request state for the EHCI debug class.
pub struct State {
    handler: DebugControlHandler,
}

impl State {
    /// Creates a new EHCI debug class state block.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            handler: DebugControlHandler {
                descriptor: [DEBUG_DESCRIPTOR_LEN as u8, descriptor_type::DEBUG, 0, 0],
                debug_mode: false,
            },
        }
    }
}

/// Owns the EHCI debug data endpoints.
pub struct EhciDebugClass<'d, D: Driver<'d>> {
    read_ep: D::EndpointOut,
    write_ep: D::EndpointIn,
}

impl<'d, D: Driver<'d>> EhciDebugClass<'d, D> {
    /// Creates the debug class on the supplied builder.
    ///
    /// CH32V307's current USBHS HAL cannot use the same endpoint index for IN
    /// and OUT, so the defaults are OUT endpoint 1 and IN endpoint 2.  coreboot
    /// reads the actual endpoint numbers from the USB debug descriptor.
    pub fn new(builder: &mut Builder<'d, D>, state: &'d mut State) -> Self {
        ch32_hal::println!("[usb-debug] creating EHCI debug interface");

        let mut function = builder.function(0xff, 0, 0);
        let mut interface = function.interface();
        let mut alt = interface.alt_setting(0xff, 0, 0, None);

        let read_ep = alt.alloc_endpoint_out(
            EndpointType::Bulk,
            Some(EndpointAddress::from_parts(1, Direction::Out)),
            DEBUG_ENDPOINT_MAX_PACKET_SIZE as u16,
            0,
        );
        alt.endpoint_descriptor(
            read_ep.info(),
            SynchronizationType::NoSynchronization,
            UsageType::DataEndpoint,
            &[],
        );

        let write_ep = alt.alloc_endpoint_in(
            EndpointType::Bulk,
            Some(EndpointAddress::from_parts(2, Direction::In)),
            DEBUG_ENDPOINT_MAX_PACKET_SIZE as u16,
            0,
        );
        alt.endpoint_descriptor(
            write_ep.info(),
            SynchronizationType::NoSynchronization,
            UsageType::DataEndpoint,
            &[],
        );

        state.handler.descriptor[2] = write_ep.info().addr.into();
        state.handler.descriptor[3] = read_ep.info().addr.into();
        ch32_hal::println!(
            "[usb-debug] endpoints: out=0x{:02x} in=0x{:02x} mps={}",
            u8::from(read_ep.info().addr),
            u8::from(write_ep.info().addr),
            DEBUG_ENDPOINT_MAX_PACKET_SIZE,
        );
        drop(function);

        builder.handler(&mut state.handler);

        Self { read_ep, write_ep }
    }

    /// Splits the class into independent read and write endpoints.
    #[must_use]
    pub fn split(self) -> (DebugOut<'d, D>, DebugIn<'d, D>) {
        (DebugOut { ep: self.read_ep }, DebugIn { ep: self.write_ep })
    }
}

/// Receives debug-console bytes written by the DUT.
pub struct DebugOut<'d, D: Driver<'d>> {
    ep: D::EndpointOut,
}

impl<'d, D: Driver<'d>> DebugOut<'d, D> {
    /// Waits until the host configuration enables the OUT endpoint.
    pub async fn wait_enabled(&mut self) {
        self.ep.wait_enabled().await;
    }

    /// Reads one EHCI debug OUT transaction.
    ///
    /// The buffer must match the advertised high-speed bulk max packet size,
    /// even though debug-mode transactions are expected to contain at most
    /// `DEBUG_TRANSACTION_SIZE` bytes.
    pub async fn read_packet(
        &mut self,
        buf: &mut [u8; DEBUG_ENDPOINT_MAX_PACKET_SIZE],
    ) -> Result<usize, embassy_usb::driver::EndpointError> {
        self.ep.read(buf).await
    }
}

/// Sends debug-console bytes to the DUT when it polls the debug IN endpoint.
pub struct DebugIn<'d, D: Driver<'d>> {
    ep: D::EndpointIn,
}

impl<'d, D: Driver<'d>> DebugIn<'d, D> {
    /// Waits until the host configuration enables the IN endpoint.
    pub async fn wait_enabled(&mut self) {
        self.ep.wait_enabled().await;
    }

    /// Writes one EHCI debug IN transaction.
    pub async fn write_packet(
        &mut self,
        data: &[u8],
    ) -> Result<(), embassy_usb::driver::EndpointError> {
        self.ep.write(data).await
    }
}

struct DebugControlHandler {
    descriptor: [u8; DEBUG_DESCRIPTOR_LEN],
    debug_mode: bool,
}

impl Handler for DebugControlHandler {
    fn enabled(&mut self, enabled: bool) {
        ch32_hal::println!("[usb-debug] device enabled={}", enabled);
    }

    fn reset(&mut self) {
        self.debug_mode = false;
        ch32_hal::println!("[usb-debug] bus reset");
    }

    fn addressed(&mut self, addr: u8) {
        ch32_hal::println!("[usb-debug] addressed addr={}", addr);
    }

    fn configured(&mut self, configured: bool) {
        ch32_hal::println!("[usb-debug] configured={}", configured);
    }

    fn suspended(&mut self, suspended: bool) {
        ch32_hal::println!("[usb-debug] suspended={}", suspended);
    }

    fn control_in<'a>(&'a mut self, req: Request, buf: &'a mut [u8]) -> Option<InResponse<'a>> {
        if req.request_type != RequestType::Standard
            || req.recipient != Recipient::Device
            || req.request != Request::GET_DESCRIPTOR
        {
            return None;
        }

        let (dtype, descriptor_index) = req.descriptor_type_index();
        if dtype != descriptor_type::DEBUG || descriptor_index != 0 {
            return None;
        }

        let len = core::cmp::min(req.length as usize, self.descriptor.len());
        buf[..len].copy_from_slice(&self.descriptor[..len]);
        ch32_hal::println!(
            "[usb-debug] GET_DESCRIPTOR(DEBUG) len={} requested={}",
            len,
            req.length,
        );
        Some(InResponse::Accepted(&buf[..len]))
    }

    fn control_out(&mut self, req: Request, data: &[u8]) -> Option<OutResponse> {
        if req.request_type != RequestType::Standard
            || req.recipient != Recipient::Device
            || req.request != Request::SET_FEATURE
        {
            return None;
        }

        if req.value == Request::FEATURE_DEVICE_DEBUG_MODE && req.index == 0 && data.is_empty() {
            self.debug_mode = true;
            ch32_hal::println!("[usb-debug] SET_FEATURE(DEBUG_MODE) accepted");
            Some(OutResponse::Accepted)
        } else {
            ch32_hal::println!(
                "[usb-debug] SET_FEATURE rejected value={} index={} data_len={}",
                req.value,
                req.index,
                data.len(),
            );
            Some(OutResponse::Rejected)
        }
    }
}
