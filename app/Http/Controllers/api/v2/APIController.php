<?php namespace App\Http\Controllers\api\v2;

use App\Http\Services\AuthAPITokenCheckServiceProvider;
use App\Http\Services\FileServiceProvider;
use App\Http\structs\DirectoryStruct;
use App\Http\structs\FileStruct;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;

class APIController
{
    public function getRootDirectory(Request $request, FileServiceProvider $provider, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        return response($provider->getCloudPathForUser($verification["user"]), 200);
    }

    public function getFilesInDirectory(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {

        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $path = $request->get("path");
        try {
            $array = array();
            foreach (File::directories($path) as $fileInfo) {
                $temp = new DirectoryStruct($fileInfo);
                array_push($array, ["type" => "dir", "data" => $temp->toArrayWithoutFiles()]);
            }

            foreach (File::files($path) as $fileInfo) {
                array_push($array, ["type" => "file", "data" => new FileStruct($fileInfo)]);
            }
            return response($array, 200);
        } catch (\Exception $e) {
            return response($e->getMessage(), 401);
        }

    }


}
