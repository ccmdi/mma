// Globals the QuickJS runtime prelude installs. The app gets these from the DOM lib;
// a procedure compiles without it, so they are declared once here for every procedure.

declare function atob(data: string): string;
declare function btoa(data: string): string;

declare class TextDecoder {
	decode(input?: ArrayBuffer | ArrayBufferView): string;
}

declare class TextEncoder {
	encode(input?: string): Uint8Array;
}
