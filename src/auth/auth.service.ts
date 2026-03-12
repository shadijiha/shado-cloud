import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { User } from "./../models/user";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { AUTH_SERVICE } from "./auth.constants";
import { EnvVariables } from "src/config/config.validator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

/**
 * Communicates with shado-auth-api via TCP microservice.
 * Auth methods (validateToken, isAdmin, verifyPassword, changePassword, changeName) use shadoUserId (UUID string).
 * getUser() resolves a shadoUserId to a local User (numeric id) for DB relations.
 */
@Injectable()
export class AuthService {
   private readonly serviceKey: string;

   constructor(
      @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
      @Inject(REDIS_CACHE) private readonly cache: Redis,
      @InjectRepository(User) private readonly userRepo: Repository<User>,
      private readonly config: ConfigService<EnvVariables>,
   ) {
      this.serviceKey = this.config.get("SERVICE_SECRET");
   }

   /** Validate a JWT cookie value → returns shadoUserId (UUID) or null */
   async validateToken(token: string): Promise<string | null> {
      const result = await firstValueFrom(
         this.authClient.send<{ userId: string | null }>("validate_token", { token, serviceKey: this.serviceKey }),
      );
      return result.userId;
   }

   /** Resolve shadoUserId → local User. Creates local record if needed. */
   async getUser(shadoUserId: string): Promise<User | null> {
      const key = `user${shadoUserId}__cache`;
      const cached = await this.cache.get(key);
      if (cached) {
         const user = JSON.parse(cached) as User;
         if (user.shadoUserId === shadoUserId) return user;
         this.cache.del(key);
      }

      const remote = await firstValueFrom(
         this.authClient.send<{ id: string; email: string } | null>(
            "get_user", { userId: shadoUserId, serviceKey: this.serviceKey },
         ),
      );
      if (!remote) return null;

      let user = await this.userRepo.findOne({ where: { shadoUserId } });
      if (!user) {
         user = new User();
         user.shadoUserId = shadoUserId;
         user = await this.userRepo.save(user);
      }

      this.cache.set(key, JSON.stringify(user));
      return user;
   }

   /** Get local User by numeric id */
   async getById(userId: number): Promise<User | null> {
      return this.userRepo.findOne({ where: { id: userId } });
   }

   /** Get email for a local user (fetched from auth-api via shadoUserId) */
   async getEmail(userId: number): Promise<string | null> {
      const user = await this.getById(userId);
      if (!user) return null;
      const remote = await firstValueFrom(
         this.authClient.send<{ email: string } | null>("get_user", { userId: user.shadoUserId, serviceKey: this.serviceKey }),
      );
      return remote?.email ?? null;
   }

   /** Check if shadoUserId is an admin */
   async isAdmin(shadoUserId: string): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("is_admin", { userId: shadoUserId, serviceKey: this.serviceKey }),
      );
   }

   /** Verify a user's password via auth-api */
   async verifyPassword(shadoUserId: string, password: string): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("verify_password", { userId: shadoUserId, password, serviceKey: this.serviceKey }),
      );
   }

   /** Change password via auth-api */
   async changePassword(shadoUserId: string, oldPassword: string, newPassword: string): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("change_password", { userId: shadoUserId, oldPassword, newPassword, serviceKey: this.serviceKey }),
      );
   }

   /** Change name via auth-api */
   async changeName(shadoUserId: string, newName: string): Promise<boolean> {
      return firstValueFrom(
         this.authClient.send<boolean>("change_name", { userId: shadoUserId, newName, serviceKey: this.serviceKey }),
      );
   }
}
