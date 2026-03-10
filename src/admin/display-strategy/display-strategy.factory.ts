import { DisplayStrategy } from "./display-strategy.interface";
import { X11DisplayStrategy } from "./x11-display.strategy";
import { MacDisplayStrategy } from "./mac-display.strategy";

export class DisplayStrategyFactory {
   static create(): DisplayStrategy {
      if (process.platform === "darwin") {
         return new MacDisplayStrategy();
      }
      return new X11DisplayStrategy();
   }
}
