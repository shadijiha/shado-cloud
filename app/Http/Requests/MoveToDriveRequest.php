<?php

namespace App\Http\Requests;

class MoveToDriveRequest extends APIRequest
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
            "path" => "required",
            "url"  => "required"
        ];
    }
}
