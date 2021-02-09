<?php

namespace App\Http\Requests;

use App\Models\APIToken;
use Carbon\Carbon;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Facades\Auth;

class APIRequest extends FormRequest
{
    /**
     * Get the validation rules that apply to the request.
     *
     * @return array
     */
    public function rules()
    {
        return [
            "key" => "nullable"
        ];
    }

    /**
     * @param bool $checkForReadonly Check if the key is read only
     *
     * @param bool $allowAuth        Allow authenticated user to make calls without counting requests
     *
     * @return bool|null
     * @throws \Exception
     */
    public function verifyToken(bool $checkForReadonly = false, bool $allowAuth = true)
    {
        /**
         * IF the user is logged in, no need for the API key
         */
        if (Auth::check() && $allowAuth) {
            return null;
        }

        $token = $this->get("key");

        $token = APIToken::where('key', $token)->firstOrFail();

        // See if the API token has expired
        if (Carbon::parse($token->expires_at)->lessThan(Carbon::now())) {
            throw new \Exception("Api token expired");
        } else if ($token->requests >= $token->max_requests) {
            // See if the maximum request has been exceeded
            throw new \Exception("Api maximum requests exhausted");
        } else {
            // Update the requests
            $token->requests += 1;
            $token->save();
        }

        // Verify that token is not readonly
        if ($checkForReadonly) {
            if ($token->readonly) {
                throw new \Exception("Cannot modify a file with a readonly API token");
            }
        }

        return true;
    }
}
