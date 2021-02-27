<?php

namespace App\Http\Requests;

class StoreFileRequest extends APIRequest
{

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array
     */
    public function rules()
    {
        return [
            "key"    => "nullable",
            "path"   => "required",
            "data"   => "nullable",
            "append" => "nullable"
        ];
    }

    /**
     * Get the error messages for the defined validation rules.
     *
     * @return array
     */
    public function messages()
    {
        return [
            'key.required'  => 'API key is required',
            'path.required' => 'path is required',
        ];
    }
}
