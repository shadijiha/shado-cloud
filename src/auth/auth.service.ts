import { Inject, Injectable, Logger } from "@nestjs/common";
import { User } from "./../models/user";
import { Repository } from "typeorm";
import argon2 from "argon2";
import { InjectRepository } from "@nestjs/typeorm";
import type Redis from "ioredis";
import { REDIS_CACHE } from "src/util";
import { LoggerToDb } from "src/logging";
@Injectable()
export class AuthService {
   constructor(
      @InjectRepository(User) private readonly userRepo: Repository<User>,
      @Inject(REDIS_CACHE) private readonly cache: Redis,
      private readonly logger: LoggerToDb,
   ) {}

   public getByEmail(email: string): Promise<User | null> {
      return this.userRepo.findOne({ where: { email } });
   }

   public async new(name: string, email: string, password: string): Promise<User> {
      const user = new User();
      user.email = email;
      user.password = await argon2.hash(password);
      user.name = name;
      return this.userRepo.save(user);
   }

   public async getById(userId: number): Promise<User | null> {
      const key = AuthService.getCachedUserKey(userId);
      const cachedValue = await this.cache.get(key);
      if (cachedValue) {
         // Attack member funtiosn back to the user
         const cachedUser = JSON.parse(cachedValue) as User;
         Object.setPrototypeOf(cachedUser, User.prototype);

         // To avoid cache paring issues, we need to assert that the user still have the same properties
         // as User class
         if (cachedUser.id === userId && "email" in cachedUser) {
            return cachedUser;
         } else {
            this.logger.warn(`Cache key ${key} is corrupted (value => ${cachedValue}), deleting it...`);
            this.cache.del(key);
         }
      }
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user) return null;

      this.cache.set(key, JSON.stringify(user));
      return user;
   }

   public async passwordMatch(userId: number, password: string) {
      const query = this.userRepo.createQueryBuilder("user");
      const user = await query
         .select("user.password")
         .where("id = :id", {
            id: userId,
         })
         .getOne();
      return await argon2.verify(user.password, password);
   }

   public getWithPassword(userId: number): Promise<User | null> {
      const query = this.userRepo.createQueryBuilder("user");
      return query
         .select("user.password")
         .addSelect("user")
         .where("id = :id", {
            id: userId,
         })
         .getOne();
   }

   private static getCachedUserKey(userId: number) {
      return `user${userId}__cache`;
   }
}
