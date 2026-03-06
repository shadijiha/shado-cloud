import { AuthUserDto } from "./auth-client/auth-client.service";

declare global {
   namespace Express {
      interface Request {
         authUser?: AuthUserDto;
      }
   }
}
