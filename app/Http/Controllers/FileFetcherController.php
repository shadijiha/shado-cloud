<?php

namespace App\Http\Controllers;

use App\Http\structs\FileStruct;
use App\Http\structs\VideoStream;
use App\Models\APIToken;
use App\Models\UploadedFile;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Symfony\Component\Finder\Exception\DirectoryNotFoundException;

class FileFetcherController extends Controller
{
    private $CLOUD_PATH;

    public function __construct()
    {
        $this->CLOUD_PATH = env("CLOUD_FILES_PATH");
    }

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function indexDirectoriesAPI(Request $request)
    {
        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        return response(["data" => new \App\Http\structs\DirectoryStruct($this->CLOUD_PATH)]);
    }

    /**
     * @param string|null $path
     *
     * @return FileStruct|\App\Http\structs\DirectoryStruct|void
     */
    public function indexDirectories(string $path = null)
    {
        $path = $path == null ? $this->CLOUD_PATH : $path;

        try {
            return new \App\Http\structs\DirectoryStruct($path);
        } catch (DirectoryNotFoundException $e) {
            // Either the path given is a file or it doesn't exist
            if (File::exists($path)) {
                return new FileStruct(new \SplFileInfo($path));
            } else {
                return abort(404, "File not found");
            }
        }
    }

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function getTreeAPI(Request $request)
    {
        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        return response(["data" => new \App\Http\structs\DirectoryStruct($request->get("path"))]);
    }

    /**
     * Gets the content of a file
     *
     * @param Request $request
     *
     * @return false|string
     */
    public function getFileAPI(Request $request)
    {
        $path  = $request->get('path');
        $token = $request->get('key');

        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        // API is ok, get the file content
        try {
            $buffer = file_get_contents($path);

            // See if the file is a image or not
            $file_struct = new FileStruct(new \SplFileInfo($path));

            // Get the originial Mime Type
            return \response()->file($path, [
                "Content-Type"        => $file_struct->getMimeType(),
                'Content-Disposition' => 'inline; filename="'.(new \SplFileInfo($path))->getFilename().'"'
            ]);

        } catch (\Exception $e) {
            $buffer = "[500] ".$e->getMessage();
        }

        return abort(500, "An internal error has occurred");
    }

    public function saveFileAPI(Request $request)
    {
        $key  = $request->get("key");
        $path = $request->get("path");
        $data = $request->get("data");

        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        if ($path == null)
            return response([
                "code"    => 401,
                "message" => "Path cannot be null"
            ]);

        // See if the path is a directory
        if (File::isDirectory($path))
            return response([
                "code"    => 401,
                "message" => "Path cannot be a directory"
            ]);

        // See if file exists, then write data directly to the file
        if (File::exists($path)) {
            try {
                $stream = fopen($path, "w");
                fwrite($stream, $data);
                fclose($stream);
            } catch (\Exception $e) {
                return response([
                    "code"    => 401,
                    "message" => $e->getMessage()
                ]);
            }
        } else {
            // Otherwise create that file
            try {
                $file = new \SplFileInfo($path);
                File::makeDirectory($file->getPath(), 0777, true, true);

                $stream = fopen($path, "w");
                fwrite($stream, $data);
                fclose($stream);

                // Add the created file to the database
                $model             = new UploadedFile();
                $model->user_id    = Auth::user()->id;
                $model->path       = UploadedFile::cleanPath($path);
                $model->updated_at = Carbon::now();
                $model->created_at = Carbon::now();
                $model->mime_type  = "text/plain";
                $model->save();

            } catch (\Exception $e) {
                return response([
                    "code"    => 401,
                    "message" => $e->getMessage()
                ]);
            }
        }

        return response([
            "code"    => 200,
            "message" => ""
        ]);
    }

    public function deleteFileAPI(Request $request)
    {
        $key  = $request->get("key");
        $path = $request->get("path");

        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        if (File::exists($path)) {

            // Verify that that path you want to delete is inside the parent cloud directory
            if (!Str::contains((new \SplFileInfo($path))->getRealPath(), (new \SplFileInfo(env("CLOUD_FILES_PATH")))->getRealPath())) {
                return response([
                    "code"    => 403,
                    "message" => "You do not have permission to modify this path",
                ]);
            }

            try {
                if (File::isDirectory($path))
                    File::deleteDirectory($path);
                else
                    File::delete($path);

                // After deletion, delete from the database
                $temp = UploadedFile::getFromPath($path);
                if ($temp)
                    $temp->delete();    // To avoid call on null

            } catch (\Exception $e) {
                return \response([
                    "code"    => 401,
                    "message" => $e->getMessage()
                ]);
            }

        } else {
            return response([
                "code"    => 401,
                "message" => "Path does not exist"
            ]);
        }

        return \response([
            "code"    => 200,
            "message" => "deleted $path with success"
        ]);
    }

    public function infoFileAPI(Request $request)
    {
        $path  = $request->get('path');
        $token = $request->get('key');

        // Verify token
        $result = $this->verifyAPIToken($request);
        if ($result != null)
            return response($result);

        // See if file exists
        if (!File::exists($path)) {
            return [
                "code"    => 401,
                "message" => "File or Dir does not exists"
            ];
        }

        return [
            "code" => 200,
            "data" => new FileStruct(new \SplFileInfo($path))
        ];
    }

    /**
     * @param Request        $request
     * @param HomeController $controller
     */
    public function uploadFile(Request $request, HomeController $controller)
    {
        $destinationPath = $request->get('path');
        $request->data->move($destinationPath, $request->data->getClientOriginalName());

        // Add to database
        $model             = new UploadedFile();
        $model->user_id    = Auth::user()->id;
        $model->path       = UploadedFile::cleanPath($destinationPath."\\".$request->data->getClientOriginalName());
        $model->updated_at = Carbon::now();
        $model->created_at = Carbon::now();
        $model->mime_type  = $request->data->getClientMimeType();
        $model->save();

        return redirect()->back();
    }

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function createDirectoryAPI(Request $request)
    {
        $path = $request->get("path");
        try {
            if ($path == null) {
                throw new \Exception('The path is null');
            }

            if (File::exists($path)) {
                throw new \Exception("The path already exists (Path: $path)");
            }

            $file = new \SplFileInfo($path."/none.temp");
            File::makeDirectory($file->getPath(), 0777, true, true);

            return response([
                "code"    => 200,
                "message" => "successfully created directory ".$file->getPath()
            ]);

        } catch (\Exception $e) {
            return response([
                "code"    => 401,
                "message" => $e->getMessage()
            ]);
        }
    }

    /**
     * Verifies if the API token is valid, not expired and under the max requests
     *
     * @param Request $request
     *
     * @param bool    $checkForReadonly
     *
     * @return array|Application|ResponseFactory|Response
     */
    private function verifyAPIToken(Request $request, bool $checkForReadonly = false)
    {
        /**
         * IF the user is logged in, no need for the API key
         */
        if (Auth::check()) {
            return null;
        }

        $token   = $request->get("key");
        $status  = 200;
        $message = "";

        try {
            $token = APIToken::where('key', $token)->firstOrFail();

            // See if the API token has expired
            if (Carbon::parse($token->expires_at)->lessThan(Carbon::now())) {
                $message = "Api token expired";
                $status  = 403;
            } else if ($token->requests >= $token->max_requests) {
                // See if the maximum request has been exceeded
                $message = "Api maximum requests exhausted";
                $status  = 401;
            } else {
                // Update the requests
                $token->requests += 1;
                $token->save();
            }

        } catch (\Exception $e) {
            $message = "Invalid API token";
            $status  = 401;
        }

        // Verify that token is not readonly
        if ($checkForReadonly) {
            if (DB::table('APITokens')->where('key', $token)->first()->readonly) {
                $status  = 401;
                $message = "Cannot modify a file with a readonly API token";
            }
        }

        if ($status != 200)
            return [
                "code"    => $status,
                "message" => $message
            ];
        else
            return null;
    }

    /**
     * @return string
     */
    public static function getCloudPath(): string
    {
        return str_replace("\\\\", "\\", (new FileFetcherController())->CLOUD_PATH);
    }
}
