import { execSync } from "child_process";
import { DisplayStrategy } from "./display-strategy.interface";
import { X11DisplayStrategy } from "./x11-display.strategy";
import { WaylandDisplayStrategy } from "./wayland-display.strategy";
import { MacDisplayStrategy } from "./mac-display.strategy";

export class DisplayStrategyFactory {
   /**
    * Detects the current display server and returns the appropriate strategy.
    * Detection order: macOS → Wayland → X11 (default)
    */
   static create(): DisplayStrategy {
      if (process.platform === "darwin") {
         return new MacDisplayStrategy();
      }

      if (this.isWayland()) {
         return new WaylandDisplayStrategy();
      }

      return new X11DisplayStrategy();
   }

   private static isWayland(): boolean {
      // Check standard Wayland env vars
      if (process.env.WAYLAND_DISPLAY) return true;
      if (process.env.XDG_SESSION_TYPE === "wayland") return true;

      // Fallback: ask loginctl
      try {
         const out = execSync("loginctl show-session $(loginctl | grep $(whoami) | awk '{print $1}') -p Type --value 2>/dev/null", { encoding: "utf-8" }).trim();
         return out === "wayland";
      } catch {
         return false;
      }
   }
}
