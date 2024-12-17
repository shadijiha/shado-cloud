import { Injectable, Logger } from '@nestjs/common'
import { User } from './../models/user'
import { Repository } from 'typeorm'
import argon2 from 'argon2'
import { InjectRepository } from '@nestjs/typeorm'

@Injectable()
export class AuthService {
  constructor (@InjectRepository(User) private readonly userRepo: Repository<User>) {}

  public async getByEmail (email: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { email } })
  }

  public async new (name: string, email: string, password: string) {
    const user = new User()
    user.email = email
    user.password = await argon2.hash(password)
    user.name = name
    return await this.userRepo.save(user)
  }

  public async getById (userId: number) {
    return await this.userRepo.findOne({ where: { id: userId } })
  }

  public async passwordMatch (userId: number, password: string) {
    const query = this.userRepo.createQueryBuilder('user')
    const user = await query
      .select('user.password')
      .where('id = :id', {
        id: userId
      })
      .getOne()
    return await argon2.verify(user.password, password)
  }

  public async getWithPassword (userId: number) {
    const query = this.userRepo.createQueryBuilder('user')
    const user = await query
      .select('user.password')
      .addSelect('user')
      .where('id = :id', {
        id: userId
      })
      .getOne()
    return user
  }
}
