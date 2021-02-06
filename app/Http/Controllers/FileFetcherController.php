<?php

namespace App\Http\Controllers;

use App\Http\Requests\DeleteFileRequest;
use App\Http\Requests\GetFileRequest;
use App\Http\Requests\StoreFileRequest;
use App\Http\Services\FileServiceProvider;
use App\Http\structs\FileStruct;
use App\Http\structs\VideoStream;
use App\Models\APIToken;
use App\Models\UploadedFile;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
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
     * @param GetFileRequest      $request
     *
     * @param FileServiceProvider $provider
     *
     * @return false|string
     */
    public function getFileAPI(GetFileRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken();
        } catch (\Exception $e) {
            return \response([
                "code"    => 401,
                "message" => $e->getMessage()
            ]);
        }

        $path  = $request->path;
        $token = $request->key;

        // API is ok, get the file content
        try {
            // See if the file is a image or not
            $file_struct = $provider->getFile($path);

            // Get the originial Mime Type
            return response()->file($path, [
                "Content-Type"        => $file_struct->getMimeType(),
                'Content-Disposition' => 'inline; filename="'.$file_struct->getNative()->getFilename().'"'
            ]);

        } catch (\Exception $e) {
            return \response([
                "code"    => 400,
                "message" => $e->getMessage()
            ]);
        }
    }

    public function saveFileAPI(StoreFileRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return \response([
                "code"    => 401,
                "message" => $e->getMessage()
            ]);
        }


        $key  = $request->key;
        $path = $request->path;
        $data = $request->data;

        // See if the path is a directory
        if (File::isDirectory($path))
            return response([
                "code"    => 401,
                "message" => "Path cannot be a directory"
            ]);

        // See if file exists, then write data directly to the file
        $provider->updateOrCreateFile($path, $data);

        return response([
            "code"    => 200,
            "message" => ""
        ]);
    }

    public function deleteFileAPI(DeleteFileRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return \response([
                "code"    => 401,
                "message" => $e->getMessage()
            ]);
        }

        $path = $request->path;

        try {
            $provider->deleteFile($path);
        } catch (\Exception $e) {
            return \response(["code"    => 401,
                              "message" => $e->getMessage()]);
        }

        return \response([
            "code"    => 200,
            "message" => "deleted $path with success"
        ]);
    }

    public
    function infoFileAPI(Request $request)
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

        // Get database info
        $struct    = new FileStruct(new \SplFileInfo($path));
        $struct_db = $struct->getUploadedFile();

        return [
            "code"  => 200,
            "props" => [
                "Filename"      => $struct->getNative()->getFilename(),
                "Extension"     => $struct->getNative()->getExtension(),
                "Full path"     => $struct->getNative()->getRealPath(),
                "MIME type"     => $struct->getMimeType(),
                "size"          => $struct->getNative()->getSize(),
                "File id"       => $struct_db == null ? "null" : $struct_db->id,
                "Owned by"      => $struct_db == null ? "null" : User::find($struct_db->user_id)->name,
                "Last modified" => $struct_db == null ? "null" : $struct_db->updated_at,
                "Created at"    => $struct_db == null ? "null" : $struct_db->created_at
            ]
        ];
    }

    public
    function renameFileAPI(Request $request)
    {
        $path    = $request->get("path");
        $newname = $request->get("newname");

        if ($path == null || $newname == null)
            return \response([
                "code"    => 401,
                "message" => "Path or newname are null"
            ]);

        // Get the uploaded file from the database
        $uploaded_file = UploadedFile::getFromPath(UploadedFile::cleanPath($path));
        $native        = new \SplFileInfo($path);

        // Get the seperator
        $seperator = PHP_OS == "Windows" || PHP_OS == "WINNT" ? "\\" : "/";

        // Rename the file
        try {
            if (File::isDirectory($path)) {
                $result = rename($path, $native->getPath().$seperator.$newname);
                if (!$result)
                    return \response([
                        "code"    => 500,
                        "message" => "Could not rename the folder"
                    ]);
                else {
                    return \response([
                        "code"    => 200,
                        "message" => "Rename file to ".$native->getPath().$seperator.$newname]);
                }

            } else {
                File::move($path, $native->getPath().$seperator.$newname);
            }

            if ($uploaded_file) {
                $uploaded_file->path = $native->getPath().$seperator.$newname;
                $uploaded_file->save();
            } else {
                // If it is not in the database then add it
                $uploaded_file             = new UploadedFile();
                $uploaded_file->user_id    = Auth::user() ? Auth::user()->id : null;
                $uploaded_file->path       = $native->getPath().$seperator.$newname;
                $uploaded_file->mime_type  = (new FileStruct(new \SplFileInfo($native->getPath().$seperator.$newname)))->getMimeType();
                $uploaded_file->updated_at = Carbon::now();
                $uploaded_file->created_at = Carbon::now();
                $uploaded_file->save();
            }

        } catch (\Exception $e) {
            return \response([
                "code"    => 500,
                "message" => $e->getMessage()
            ]);
        }

        return \response([
            "code"    => 200,
            "message" => "Filename changed"
        ]);
    }

    /**
     * @param Request        $request
     * @param HomeController $controller
     */
    public
    function uploadFile(Request $request, HomeController $controller)
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
    public
    function createDirectoryAPI(Request $request)
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
    private
    function verifyAPIToken(Request $request, bool $checkForReadonly = false)
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
    public
    static function getCloudPath(): string
    {
        return str_replace("\\\\", "\\", (new FileFetcherController())->CLOUD_PATH);
    }
}
