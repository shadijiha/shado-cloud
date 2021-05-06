<?php namespace App\Http\Controllers\api\v2;

use App\Http\Services\AuthAPITokenCheckServiceProvider;
use App\Models\AuthToken;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;

class AuthAPIController
{
    public function login(Request $request)
    {
        $email    = $request->get("email");
        $password = $request->get("password");

        $user = User::where("email", $email)->first();
        if ($user == null)
            return response(["errors" => ["User does not exist"]], 400);

        if (Hash::check($password, $user->password)) {
            $token     = AuthToken::generate($user);
            $token->ip = $request->getClientIp();
            $token->save();

            Auth::attempt(["email" => $email, "password" => $password]);

            return response([
                "user"  => $user,
                "token" => $token
            ]);
        } else {
            return response(["errors" => ["Invalid credentials"]], 400);
        }
    }

    public function ping(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $result = $tokenServiceProvider->verifyToken($request);
        if ($result["code"] == 200) {
            return response("Pong!", 200);
        } else {
            return response($result["message"], $result["code"]);
        }
    }


}
