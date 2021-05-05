<?php namespace App\Http\Controllers\api\v2;

use App\Http\Requests\StoreFileRequest;
use App\Http\Services\AuthAPITokenCheckServiceProvider;
use App\Http\Services\FileServiceProvider;
use App\Http\structs\DirectoryStruct;
use App\Http\structs\FileStruct;
use App\Models\APIToken;
use App\Models\UploadedFile;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class APIController
{
    public function getRootDirectory(Request $request, FileServiceProvider $provider, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        return response($provider->getCloudPathForUser($verification["user"]), 200);
    }

    public function getFilesInDirectory(Request $request, FileServiceProvider $provider, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {

        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $path = $request->get("path");

        if (!$path || !$provider->ownsDirectory($verification["user"], $path)) {
            return response("User is null or does not own directory", 401);
        }

        $lockedPath = DirectoryStruct::removeSlashes($provider->getCloudPathForUser($verification["user"]));
        $path       = DirectoryStruct::removeSlashes($path);
        $parent     = (new DirectoryStruct($path))->parent;

        try {
            $array = array();
            foreach (File::directories($path) as $fileInfo) {
                $temp = new DirectoryStruct($fileInfo);
                array_push($array, ["type" => "dir", "data" => $temp->toArrayWithoutFiles()]);
            }

            foreach (File::files($path) as $fileInfo) {
                $struct = new FileStruct($fileInfo);
                array_push($array, ["type" => "file", "data" => $struct->toArray()]);
            }
            return response([
                "superparent" => $path == $lockedPath ? null : $parent,
                "files"       => $array
            ], 200);
        } catch (\Exception $e) {
            return response($e->getMessage(), 401);
        }

    }

    public function getFilesInfo(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $path   = $request->get("path");
        $struct = new FileStruct(new \SplFileInfo($path));
        return response($struct->toArray(), 200);
    }

    public function uploadFile(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider, FileServiceProvider $provider)
    {

        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $destinationPath = $request->get('path');

        if (!$provider->ownsDirectory($verification["user"], $destinationPath)) {
            return response("User does not own directory", 401);
        }

        $request->data->move($destinationPath, $request->data->getClientOriginalName());

        // Add to database
        $model             = new UploadedFile();
        $model->user_id    = $verification["user"]->id;
        $model->path       = UploadedFile::cleanPath($destinationPath.$provider->getOSSeperator().$request->data->getClientOriginalName());
        $model->updated_at = Carbon::now();
        $model->created_at = Carbon::now();
        $model->mime_type  = $request->data->getClientMimeType();
        $model->save();

        return response([
            "message" => "success"
        ], 200);
    }

    public function createDirectory(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider, FileServiceProvider $provider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $path = $request->get("path");
        $name = $request->get("name");

        try {
            if ($path == null || $name == null) {
                throw new \Exception('The path or name is null');
            }

            $fullepath = $path.$provider->getOSSeperator().$name;
            if (File::exists($fullepath)) {
                throw new \Exception("The path already exists (Path: $path)");
            }

            File::makeDirectory($fullepath, 0777, true, true);

            return response(["message" => "successfully created directory ".$fullepath], 200);

        } catch (\Exception $e) {
            return response([
                "message" => $e->getMessage()
            ], 400);
        }
    }

    public function createFile(Request $request, \App\Http\Controllers\APIController $provider)
    {
        $temp = new StoreFileRequest([
            "key"    => $request->get("key"),
            "path"   => $request->get("path"),
            "data"   => $request->get("data"),
            "append" => $request->get("append")

        ]);
        $temp->setMethod("POST");
        return $provider->saveFileAPI($temp, new FileServiceProvider());
    }

    public function getAPIKeys(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        return response(
            APIToken::where("user_id", $verification["user"]->id)
                ->orderBy("expires_at", 'desc')
                ->get()
        );
    }

    public function deleteAPIKey(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $id = $request->get("id");
        APIToken::find($id)->delete();
        return response(["message" => "Success deleted API key"], 200);
    }

    public function generateAPIKey(Request $request, AuthAPITokenCheckServiceProvider $tokenServiceProvider)
    {
        $verification = $tokenServiceProvider->verifyToken($request);
        if ($verification["code"] != 200)
            return response($verification["message"], $verification["code"]);

        $token           = new APIToken();
        $token->user_id  = $verification["user"]->id;
        $token->readonly = $request->get("readonly") ?? true;

        $token->expires_at = $request->get("expiration") == null ?
            Carbon::now()->addHours(24) : Carbon::parse($request->get("expiration"));

        $token->requests     = 0;
        $token->max_requests = $request->get("max_requests") ?? 100;
        $token->key          = Str::random(32);
        $token->save();

        return response($token, 200);
    }
}
