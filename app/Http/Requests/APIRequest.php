<?php

namespace App\Http\Requests;

use App\Models\APIToken;
use App\Models\UploadedFile;
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
            "key"  => "nullable",
            "path" => "nullable"
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
        // TODO: There is a bug here, Must check if the auth is the directory/File owner

        $uploaded_file = UploadedFile::getFromPath($this->get("path")) ?? null;
        if (Auth::check() && $allowAuth) {
            // Check if the file is owned by the login user
            if ($uploaded_file && $uploaded_file->user_id == Auth::user()->id) {
                return null;
            }
        }

        $token = $this->get("key");
        $token = APIToken::where('key', $token)->firstOrFail();

        // Check if the the key issuer is the same as the document owner
        // If the file is in database (meaning we have his owner)
        if ($uploaded_file && $uploaded_file->user_id != $token->user_id) {
            throw new \Exception("The API key must be issued by the owner of the file/directory");
        }

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
        if ($checkForReadonly && $token->readonly) {
            throw new \Exception("Cannot modify a file with a readonly API token");
        }


        return true;
    }
}
