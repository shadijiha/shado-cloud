<?php namespace App\Http\Services;

use App\Models\AuthToken;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Http\Request;

class AuthAPITokenCheckServiceProvider
{
    public function verifyToken(Request $request): array
    {
        $message = "";

        $token = AuthToken::where("token", $request->header("Authorization"))->first();
        if ($token == null)
            return ["code"    => 401,
                    "message" => "Invalid token",
                    "user"    => null,
                    "token"   => null];

        $user = User::where("id", $token->user_id)->first();
        if ($user == null)
            return ["code"    => 401,
                    "message" => "Tokens\'s user does not exist",
                    "user"    => null,
                    "token"   => $token];


        if (!(Carbon::now()->lessThan($token->expires_at))) {
            return ["code"    => 401,
                    "message" => "This token is expired",
                    "user"    => null,
                    "token"   => null];
        }

        return ["code"  => 200,
                "user"  => $user,
                "token" => $token];
    }
}
