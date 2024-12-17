import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

@Injectable()
export class CORPMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction) {
        // Set the Cross-Origin-Resource-Policy header to cross-origin
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        next();
    }
}
