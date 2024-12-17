/**
 * Types for all The Requests and Responses of the Auth Controller
 */
import { ApiProperty } from '@nestjs/swagger'
import { IsEmail, IsNotEmpty } from 'class-validator'
import { User } from 'src/models/user'

class FieldError {
  @ApiProperty()
    field: string

  @ApiProperty()
    message: string
}

export class ErrorProne {
  @ApiProperty({ type: [FieldError] })
    errors: FieldError[] = []
}

// Login
export class LoginRequest {
  @ApiProperty()
  @IsEmail()
    email: string

  @ApiProperty()
  @IsNotEmpty()
    password: string
}

export class LoginResponse extends ErrorProne {
  @ApiProperty()
    user: User
}

// Register
export class RegisterRequest {
  @ApiProperty()
  @IsNotEmpty()
    name: string

  @ApiProperty()
  @IsEmail()
    email: string

  @ApiProperty()
  @IsNotEmpty()
    password: string
}

// Cookie
export interface CookiePayload {
  userId: number
}
