<?php

namespace App\Http\Requests;

class RenameFileRequest extends APIRequest
{
    /**
     * Get the validation rules that apply to the request.
     *
     * @return array
     */
    public function rules()
    {
        return [
            "key"     => "nullable",
            "path"    => "required",
            "newname" => "required",
        ];
    }
}
