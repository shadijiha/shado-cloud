import { exec, execSync } from "child_process";
import { promisify } from "util";
import { DisplayStrategy, ScreenInfo } from "./display-strategy.interface";
import { networkInterfaces } from "os";

const execAsync = promisify(exec);

export class X11DisplayStrategy implements DisplayStrategy {
   readonly name = "X11";
   private readonly env: NodeJS.ProcessEnv;

   constructor() {
      const xauth = process.env.XAUTHORITY
         || (() => { try { return execSync("find /run -name Xauthority 2>/dev/null").toString().trim().split("\n")[0]; } catch { return ""; } })()
         || `${process.env.HOME || "/root"}/.Xauthority`;

      this.env = {
         ...process.env,
         DISPLAY: process.env.DISPLAY || ":0",
         XAUTHORITY: xauth,
      };
   }

   async getScreenInfo(): Promise<ScreenInfo> {
      const { stdout } = await execAsync("xdpyinfo | grep dimensions | awk '{print $2}'", { env: this.env });
      const [w, h] = stdout.trim().split("x").map(Number);
      return { width: w || 1920, height: h || 1080 };
   }

   getStreamUrl(): string {
      return "/whep";
   }

   getScreenshotMimeType(): string {
      return "image/jpeg";
   }

   getScreenshotCommand(): string {
      return "scrot -p -o /tmp/screen.jpg -q 20 && base64 /tmp/screen.jpg";
   }

   async mouseMove(x: number, y: number): Promise<void> {
      await execAsync(`xdotool mousemove ${x} ${y}`, { env: this.env });
   }

   async mouseClick(x: number, y: number, button: number): Promise<void> {
      await execAsync(`xdotool mousemove ${x} ${y} click ${button}`, { env: this.env });
   }

   async mouseDown(x: number, y: number, button: number): Promise<void> {
      await execAsync(`xdotool mousemove ${x} ${y} mousedown ${button}`, { env: this.env });
   }

   async mouseUp(x: number, y: number, button: number): Promise<void> {
      await execAsync(`xdotool mousemove ${x} ${y} mouseup ${button}`, { env: this.env });
   }

   async mouseScroll(x: number, y: number, scrollY: number): Promise<void> {
      const direction = scrollY > 0 ? 5 : 4;
      await execAsync(`xdotool mousemove ${x} ${y} click ${direction}`, { env: this.env });
   }

   async keyPress(key: string): Promise<void> {
      await execAsync(`xdotool key ${X11_KEY_MAP[key] || key}`, { env: this.env });
   }

   async typeChar(char: string): Promise<void> {
      await execAsync(`xdotool type --clearmodifiers "${char}"`, { env: this.env });
   }

   async getFfmpegCommand(fps: number): Promise<string> {
      const { width, height } = await this.getScreenInfo();
      const bitrate = Math.round(fps * 100); // ~1500k@15fps, 3000k@30fps, 6000k@60fps, 14400k@144fps
      return `ffmpeg -f x11grab -framerate ${fps} -video_size ${width}x${height} -draw_mouse 1 -i :0 -f pulse -i default -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v ${bitrate}k -maxrate ${bitrate}k -bufsize ${bitrate * 2}k -g ${fps} -c:a aac -b:a 128k -f rtsp rtsp://localhost:$RTSP_PORT/$MTX_PATH`;
   }
}

const X11_KEY_MAP: Record<string, string> = {
   " ": "space", Enter: "Return", Backspace: "BackSpace", Tab: "Tab",
   Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
   ArrowRight: "Right", Shift: "shift", Control: "ctrl", Alt: "alt",
   Meta: "super", Delete: "Delete", Home: "Home", End: "End",
   PageUp: "Page_Up", PageDown: "Page_Down",
};
