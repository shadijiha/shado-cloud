import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { AuthStrategy } from "src/auth/auth.strategy";
import { CookiePayload } from "src/auth/authApiTypes";
import { User } from "src/models/user";
import { parseJwt } from "src/util";

@Injectable()
export class AdminGuard implements CanActivate {
	async canActivate(ctx: ExecutionContext): Promise<boolean> {
		const request = <Request>ctx.switchToHttp().getRequest();
		const payload = <CookiePayload>(
			parseJwt(request.cookies[process.env.COOKIE_NAME])
		);

		const user = await User.findOne({ where: { id: payload.userId } });

		if (user) {
			return user.is_admin;
		}
		return false;
	}
}

/*export class AdminGuard extends AuthStrategy {
	async validate(data: CookiePayload) {
		const user = await User.findOne({ where: { id: data.userId } });

		if (user) {
			return user.is_admin;
		}

		return false;
	}
}*/
