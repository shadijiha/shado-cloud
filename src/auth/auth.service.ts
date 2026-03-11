import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { User } from "./../models/user";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { AUTH_SERVICE } from "./auth.constants";

/**
 * Communicates with shado-auth-api via TCP microservice.
 */
@Injectable()
export class AuthService {
   constructor(
      @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
      @Inject(REDIS_CACHE) private readonly cache: Redis,
   ) {}

   /** Validate a JWT cookie value → returns userId or null */
   async validateToken(token: string): Promise<number | null> {
      const result = await firstValueFrom(
         this.authClient.send<{ userId: number | null }>("validate_token", { token }),
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
         this.authClient.send<User | null>("get_user", { userId }),
      );
      if (user) this.cache.set(key, JSON.stringify(user));
      return user;
   }

   /** Get user by ID including password hash */
   async getWithPassword(userId: number): Promise<User | null> {
      return firstValueFrom(
         this.authClient.send<User | null>("get_user_with_password", { userId }),
      );
   }

   /** Check if userId is an admin */
   async isAdmin(userId: number): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("is_admin", { userId }),
      );
   }
}
