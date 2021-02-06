<?php

namespace App\Http\Requests;

class DeleteFileRequest extends APIRequest
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
        ];
    }
}
