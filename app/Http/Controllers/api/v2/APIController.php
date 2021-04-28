<?php namespace App\Http\Controllers\api\v2;

use App\Http\Services\AuthAPITokenCheckServiceProvider;
use App\Http\Services\FileServiceProvider;
use App\Http\structs\DirectoryStruct;
use App\Http\structs\FileStruct;
use App\Models\APIToken;
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
                $struct = new FileStruct($fileInfo);
                array_push($array, ["type" => "file", "data" => $struct->toArray()]);
            }
            return response($array, 200);
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
