import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { type Request } from 'express'
import { AuthStrategy } from 'src/auth/auth.strategy'
import { type CookiePayload } from 'src/auth/authApiTypes'
import { User } from 'src/models/user'
import { parseJwt } from 'src/util'
import { Repository } from 'typeorm'

@Injectable()
export class AdminGuard implements CanActivate {
  public constructor (@InjectRepository(User) private readonly userRepo: Repository<User>) {}

  async canActivate (ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest()
    const payload = parseJwt(request.cookies[process.env.COOKIE_NAME]) as CookiePayload

    if (!payload?.userId) {
      return false
    }

    const user = await this.userRepo.findOne({ where: { id: payload.userId } })
    if (user) {
      return user.is_admin
    }
    return false
  }
}
