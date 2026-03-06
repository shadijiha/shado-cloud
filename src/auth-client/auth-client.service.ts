import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { AUTH_SERVICE } from "./constants";

export interface AuthUserDto {
   id: string;
   email: string;
   name: string;
   isAdmin: boolean;
}

interface VerifyResult {
   valid: boolean;
   user?: AuthUserDto;
   claims?: Record<string, any>;
   error?: string;
}

@Injectable()
export class AuthClientService {
   constructor(@Inject(AUTH_SERVICE) private readonly client: ClientProxy) {}

   register(email: string, password: string, name?: string) {
      return firstValueFrom(this.client.send("auth.register", { email, password, name }));
   }

   login(email: string, password: string) {
      return firstValueFrom(this.client.send("auth.login", { email, password }));
   }

   verify(token: string): Promise<VerifyResult> {
      return firstValueFrom(this.client.send("auth.verify", { token }));
   }

   sign(userId: string, email: string, tokenVersion?: number, extraClaims?: Record<string, any>): Promise<{ token: string }> {
      return firstValueFrom(this.client.send("auth.sign", { userId, email, tokenVersion, extraClaims }));
   }

   getUser(id: string): Promise<AuthUserDto | null> {
      return firstValueFrom(this.client.send("auth.getUser", { id }));
   }

   me(token: string): Promise<AuthUserDto & { error?: string }> {
      return firstValueFrom(this.client.send("auth.me", { token }));
   }

   getUserByEmail(email: string): Promise<AuthUserDto | null> {
      return firstValueFrom(this.client.send("auth.getUserByEmail", { email }));
   }

   changePassword(id: string, oldPassword: string, newPassword: string) {
      return firstValueFrom(this.client.send("auth.changePassword", { id, oldPassword, newPassword }));
   }

   changeName(id: string, name: string) {
      return firstValueFrom(this.client.send("auth.changeName", { id, name }));
   }
}
