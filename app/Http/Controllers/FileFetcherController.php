<?php

namespace App\Http\Controllers;

use App\Models\APIToken;
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

class DirectoryStruct
{
    public $parent;
    public $files;
    public $path;
    public $children;
    public $name;

    public function __construct(string $path)
    {
        $this->path = $this->removeSlashes($path);

        // Get parent dir
        $delimiter = "\\";
        if (Str::contains($path, "/"))
            $delimiter = "/";

        $tokens                     = explode($delimiter, $path);
        $tokens[count($tokens) - 1] = "";
        $this->parent               = $this->removeSlashes(implode($delimiter, $tokens));

        // Get all files
        $this->files = array();
        foreach (File::files($this->path) as $file) {
            array_push($this->files, new FileStruct($file));
        }

        // Get all children
        $this->children = array();
        foreach (File::directories($this->path) as $dir) {
            array_push($this->children, new DirectoryStruct($dir));
        }

        // Compute name
        $tokens     = explode($delimiter, $this->path);
        $this->name = $tokens[count($tokens) - 1];
    }

    public function toString()
    {
        return $this;
    }

    private function removeSlashes(string $str): string
    {
        return preg_replace("/\\\+/", '\\', $str);
    }

    /**
     * @return string
     */
    public function getRelativePath(): string
    {
        $temp = str_replace("\\", "/", str_replace(FileFetcherController::getCloudPath()."\\", "", $this->path));
        return $temp;
    }
}

class FileStruct
{
    public $name;
    public $extension;
    public $path;
    public $native;
    public $url;

    public function __construct(\SplFileInfo $file)
    {
        $this->name      = $file->getFilename();
        $this->extension = $file->getExtension();
        $this->path      = $file->getRealPath();
        $this->native    = $file;

        $token     = Auth::user()->validAPITokens()->first();
        $token     = $token == null ? "{YOUR_API_KEY}" : $token->key;
        $this->url = url("/")."/api?key=$token&path=$this->path";
    }

    /**
     * @return string
     */
    public function getRelativePath(): string
    {
        return str_replace("\\", "/", str_replace(FileFetcherController::getCloudPath()."\\", "", $this->path));
    }

    /**
     * @return \SplFileInfo
     */
    public function getNative()
    {
        return $this->native;
    }
}

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

        return response(["data" => new DirectoryStruct($this->CLOUD_PATH)]);
    }

    /**
     * @param string|null $path
     *
     * @return FileStruct|DirectoryStruct|void
     */
    public function indexDirectories(string $path = null)
    {
        $path = $path == null ? $this->CLOUD_PATH : $path;

        try {
            return new DirectoryStruct($path);
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

        return response(["data" => new DirectoryStruct($request->get("path"))]);
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
        } catch (\Exception $e) {
            $buffer = "[500] ".$e->getMessage();
        }

        return $buffer;
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

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function createDirectory(Request $request)
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
