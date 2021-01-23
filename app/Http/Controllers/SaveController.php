<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\File;

class SaveController extends Controller
{
    const SUCESSFUL_SAVE = 0;
    const ERROR_SAVE = 1;


    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function save(Request $request)
    {
        $status  = SaveController::SUCESSFUL_SAVE;
        $message = "";

        try {
            File::put($request->get("path"), $request->get("content"));

        } catch (\Exception $e) {
            $status  = SaveController::ERROR_SAVE;
            $message = $e->getMessage();
        }

        return response([
            "status"  => $status,
            "message" => $message,
            "request" => $request->all(),
        ]);
    }
}
