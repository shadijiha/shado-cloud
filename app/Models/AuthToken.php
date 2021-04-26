<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

class AuthToken extends Model
{
    use HasFactory;

    protected $table = "auth_tokens";

    public static function generate(User $user)
    {
        $token             = new AuthToken();
        $token->token      = Str::random(64);
        $token->user_id    = $user->id;
        $token->expires_at = Carbon::now()->addMinutes(30);

        $token->save();

        return $token;
    }

}
