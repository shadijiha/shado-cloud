export interface ScreenInfo {
   width: number;
   height: number;
}

export interface DisplayStrategy {
   /** Human-readable name for logging */
   readonly name: string;

   /** Get the current screen resolution */
   getScreenInfo(): Promise<ScreenInfo>;

   /** Get the WebRTC/WHEP URL for live streaming */
   getStreamUrl(): string;

   /** Shell command for MJPEG screenshot fallback */
   getScreenshotCommand(): string;

   /** Move the mouse cursor */
   mouseMove(x: number, y: number): Promise<void>;

   /** Click at position */
   mouseClick(x: number, y: number, button: number): Promise<void>;

   /** Scroll at position */
   mouseScroll(x: number, y: number, scrollY: number): Promise<void>;

   /** Press a key */
   keyPress(key: string): Promise<void>;

   /** Type a single character */
   typeChar(char: string): Promise<void>;
}
