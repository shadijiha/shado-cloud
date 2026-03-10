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

   /** MIME type of the screenshot output */
   getScreenshotMimeType(): string;

   /** Move the mouse cursor */
   mouseMove(x: number, y: number): Promise<void>;

   /** Click at position */
   mouseClick(x: number, y: number, button: number): Promise<void>;

   /** Press mouse button at position (for drag start) */
   mouseDown(x: number, y: number, button: number): Promise<void>;

   /** Release mouse button at position (for drag end) */
   mouseUp(x: number, y: number, button: number): Promise<void>;

   /** Scroll at position */
   mouseScroll(x: number, y: number, scrollY: number): Promise<void>;

   /** Press a key */
   keyPress(key: string): Promise<void>;

   /** Type a single character */
   typeChar(char: string): Promise<void>;

   /** Get the ffmpeg runOnDemand command for MediaMTX at a given FPS */
   getFfmpegCommand(fps: number): Promise<string | null>;
}
