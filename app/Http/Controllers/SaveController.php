<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreFileRequest;
use App\Http\Services\FileServiceProvider;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

class SaveController extends Controller
{
    const SUCESSFUL_SAVE = 0;
    const ERROR_SAVE = 1;


    /**
     * @param StoreFileRequest    $request
     *
     * @param FileServiceProvider $provider
     *
     * @return Application|ResponseFactory|Response
     */
    public function save(StoreFileRequest $request, FileServiceProvider $provider)
    {
        $status  = SaveController::SUCESSFUL_SAVE;
        $message = "";

        try {
            $provider->updateOrCreateFile($request->path, $request->data);
        } catch (\Exception $e) {
            $status  = SaveController::ERROR_SAVE;
            $message = $e->getMessage();
        }

        return response([
            "status"  => $status,
            "message" => $message,
        ]);
    }

    public function unzipFile(Request $request, FileServiceProvider $provider)
    {
        $path = $request->get("path");

        try {
            $provider->unzipFile($path);
        } catch (\Exception $e) {
            return \response([
                "code"    => 400,
                "message" => $e->getMessage()
            ]);
        }

        return \response([
            "code"    => 200,
            "message" => ""
        ]);
    }
}
