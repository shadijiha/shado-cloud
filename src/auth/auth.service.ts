import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { User } from "./../models/user";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { AUTH_SERVICE } from "./auth.constants";
import { EnvVariables } from "src/config/config.validator";

/**
 * Communicates with shado-auth-api via TCP microservice.
 */
@Injectable()
export class AuthService {
   private readonly serviceKey: string;

   constructor(
      @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
      @Inject(REDIS_CACHE) private readonly cache: Redis,
      private readonly config: ConfigService<EnvVariables>,
   ) {
      this.serviceKey = this.config.get("SERVICE_SECRET");
   }

   /** Validate a JWT cookie value → returns userId or null */
   async validateToken(token: string): Promise<number | null> {
      const result = await firstValueFrom(
         this.authClient.send<{ userId: number | null }>("validate_token", { token, serviceKey: this.serviceKey }),
      );
      return result.userId;
   }

   /** Get user by ID (with Redis cache) */
   async getById(userId: number): Promise<User | null> {
      const key = `user${userId}__cache`;
      const cached = await this.cache.get(key);
      if (cached) {
         const user = JSON.parse(cached) as User;
         if (user.id === userId && "email" in user) return user;
         this.cache.del(key);
      }

      const user = await firstValueFrom(
         this.authClient.send<User | null>("get_user", { userId, serviceKey: this.serviceKey }),
      );
      if (user) this.cache.set(key, JSON.stringify(user));
      return user;
   }

   /** Check if userId is an admin */
   async isAdmin(userId: number): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("is_admin", { userId, serviceKey: this.serviceKey }),
      );
   }

   /** Verify a user's password without exposing the hash */
   async verifyPassword(userId: number, password: string): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("verify_password", { userId, password, serviceKey: this.serviceKey }),
      );
   }
}
