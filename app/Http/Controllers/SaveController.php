<?php

namespace App\Http\Controllers;

use App\Models\UploadedFile;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
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

            // After the file has been modified, Updated the updated_at column
            $db_struct = UploadedFile::getFromPath($request->get("path"));
            if ($db_struct) {
                $db_struct->updated_at = Carbon::now();
                $db_struct->save();
            } else {
                // If it is not there, then attempt to insert it
                $db_struct             = new UploadedFile();
                $db_struct->path       = UploadedFile::cleanPath($request->get("path"));
                $db_struct->mime_type  = "text/plain";
                $db_struct->user_id    = Auth::user() == null ? null : Auth::user()->id;
                $db_struct->created_at = Carbon::now();
                $db_struct->updated_at = Carbon::now();
                $db_struct->save();
            }

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
