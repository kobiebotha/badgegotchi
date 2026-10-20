// Minimal structural WebUSB types keep the browser adapter mockable without
// installing globals for an API unavailable in several supported browsers.
export interface UsbEndpoint {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
}
export interface UsbAlternate {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly endpoints: readonly UsbEndpoint[];
}
export interface UsbInterface {
  readonly interfaceNumber: number;
  readonly alternate: UsbAlternate;
  readonly alternates: readonly UsbAlternate[];
}
export interface UsbConfiguration {
  readonly configurationValue: number;
  readonly interfaces: readonly UsbInterface[];
}
export interface UsbControlSetup {
  requestType: "vendor";
  recipient: "interface";
  request: number;
  value: number;
  index: number;
}
export interface UsbInResult {
  status: "ok" | "stall" | "babble";
  data?: DataView;
}
export interface UsbOutResult {
  status: "ok" | "stall";
  bytesWritten: number;
}
export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly configuration?: UsbConfiguration;
  readonly configurations: readonly UsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  releaseInterface(number: number): Promise<void>;
  selectAlternateInterface(number: number, alternate: number): Promise<void>;
  clearHalt(direction: "in" | "out", endpoint: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<UsbInResult>;
  transferOut(endpoint: number, data: Uint8Array<ArrayBuffer>): Promise<UsbOutResult>;
  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInResult>;
  controlTransferOut(setup: UsbControlSetup): Promise<UsbOutResult>;
}
export interface UsbNavigator {
  requestDevice(options: {
    filters: { vendorId: number; productId: number }[];
  }): Promise<UsbDevice>;
}
