import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::socket::socket_body" });

const TCPSocket = b.classRef("TCPSocket");
const TLSSocket = b.classRef("TLSSocket");

export const BunSocket = b.union({ tcp: TCPSocket, tls: TLSSocket });
/** The `_handle` of a `net.Socket`: `new net.Socket({ handle })` keeps any object. */
export const SocketHandle = b.union({ tcp: TCPSocket, tls: TLSSocket, ignored: b.any });

export const upgradeTLSDeferred = b.fn({
  args: { socket: BunSocket, options: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
export const releaseHeldFlight = b.fn({ args: { socket: SocketHandle } });
export const checkServerIdentityInHandshake = b.fn({ args: { socket: SocketHandle, inHandshake: b.bool } });
export const firstFlightBeforeFin = b.fn({ args: { socket: SocketHandle } });
export const isNamedPipeSocket = b.fn({ args: { socket: SocketHandle }, returns: b.bool });
export const hasNativeSocketListeners = b.fn({ args: { socket: SocketHandle }, returns: b.bool });
export const getBufferedAmount = b.fn({ args: { socket: SocketHandle }, returns: b.usize });

// Internal StreamBase ownership for node:tls; generic Duplexes retain JSStreamSocket.
export const attachNativeTLSTransport = b.fn({
  args: { socket: TLSSocket, transport: SocketHandle, previousWrites: b.bool, initialData: b.any, token: b.any },
  returns: b.bool,
  capability: "js",
  throws: true,
});
export const nativeTLSPreviousWritesDone = b.fn({ args: { socket: TLSSocket } });
export const shutdownNativeTLSTransport = b.fn({
  args: { socket: SocketHandle, callback: b.any },
  returns: b.bool,
  capability: "js",
});
