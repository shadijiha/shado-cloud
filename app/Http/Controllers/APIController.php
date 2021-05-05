<?php

namespace App\Http\Controllers;

use App\Http\Requests\APIRequest;
use App\Http\Requests\DeleteFileRequest;
use App\Http\Requests\GetFileRequest;
use App\Http\Requests\MoveToDriveRequest;
use App\Http\Requests\RenameFileRequest;
use App\Http\Requests\StoreFileRequest;
use App\Http\Services\FileServiceProvider;
use App\Http\structs\DirectoryStruct;
use App\Http\structs\FileStruct;
use App\Models\APIToken;
use App\Models\UploadedFile;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Symfony\Component\Finder\Exception\DirectoryNotFoundException;

class APIController extends Controller
{
    /**
     * @param APIRequest          $request
     *
     * @param FileServiceProvider $provider
     *
     * @return Application|ResponseFactory|Response
     */
    public function indexDirectoriesAPI(APIRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken();

            $path  = $request->get("path");
            $token = APIToken::where("key", $request->get("key"))->firstOrFail();
            if (!$request->get("path"))
                $path = $provider->getCloudPath().$provider->getOSSeperator().$token->user->email;

        } catch (\Exception $e) {
            return \response($e->getMessage(), 400);
        }


        return response(["data" => new DirectoryStruct($path)]);
    }

    /**
     * @param string|null $path
     *
     * @return FileStruct|DirectoryStruct|void
     */
    public function indexDirectories(string $path = null)
    {
        $path = $path == null ? (new FileServiceProvider())->getCloudPath() : $path;

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
     * @param APIRequest          $request
     *
     * @param FileServiceProvider $provider
     *
     * @return Application|ResponseFactory|Response
     */
    public function getTreeAPI(APIRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken();
        } catch (\Exception $e) {
            return \response($e->getMessage(), 400);
        }

        return response(["tree" => new DirectoryStruct($request->get("path") ?? $provider->getCloudPath())]);
    }

    /**
     * Gets the content of a file
     *
     * @param GetFileRequest      $request
     *
     * @param FileServiceProvider $provider
     *
     * @param HomeController      $homeController
     *
     * @return false|string
     */
    public function getFileAPI(GetFileRequest $request, FileServiceProvider $provider, HomeController $homeController)
    {
        // Verify token
        try {
            $request->verifyToken();
        } catch (\Exception $e) {
            return response($e->getMessage(), 401);
        }

        $path  = $request->path;
        $token = $request->key;

        // API is ok, get the file content
        try {
            // If file is a directory
            if (File::isDirectory($path)) {
                return $homeController->index($request, $this, new FileServiceProvider());
            }

            $file_struct = $provider->getFile($path);

            // Get the originial Mime Type
            return response()->file($path, [
                "Content-Type"        => $file_struct->getMimeType(),
                'Content-Disposition' => 'inline; filename="'.$file_struct->getNative()->getFilename().'"'
            ]);

        } catch (\Exception $e) {
            return \response($e->getMessage(), 400);
        }
    }

    public function saveFileAPI(StoreFileRequest $request, FileServiceProvider $provider)
    {
        //error_log($request->get("key"));
        // Verify token
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return response(["message" => $e->getMessage()], 400);
        }


        $key = $request->key;

        $path   = $request->path;
        $data   = $request->data ?? "";
        $append = strcmp(Str::lower($request->append), "true") === 0;

        // See if the path is a directory
        if (File::isDirectory($path))
            return response(["message" => "Path cannot be a directory"], 401);

        // See if file exists, then write data directly to the file
        $provider->updateOrCreateFile($path, $data, $append);

        return response(["data" => $data], 200);
    }

    public function deleteFileAPI(DeleteFileRequest $request, FileServiceProvider $provider)
    {
        // Verify token
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }

        $path = $request->path;

        try {
            $provider->deleteFile($path);
        } catch (\Exception $e) {
            return \response(["code"    => 401,
                              "message" => $e->getMessage()]);
        }

        return \response("deleted $path with success", 200);
    }

    public function infoFileAPI(GetFileRequest $request, FileServiceProvider $provider)
    {
        $path = $request->path;

        // Verify token
        try {
            $request->verifyToken();

            // Get database info
            $struct = $provider->getFile($path);
        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }

        return response($struct->getProps(), 200);
    }

    public function renameFileAPI(RenameFileRequest $request, FileServiceProvider $provider)
    {
        $path    = $request->path;
        $newname = $request->newname;

        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }

        // Rename the file
        try {
            $provider->renameFile($path, $newname);
        } catch (\Exception $e) {
            return response($e->getMessage(), 500);
        }

        return \response("Filename changed", 200);
    }

    public function copyFileToDriveAPI(MoveToDriveRequest $request, FileServiceProvider $provider)
    {
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }

        // TODO: Needs security. E.g. verify if this user can change the requested dir

        $provider->copyFile($request->url, $request->path);

        return \response("", 200);
    }

    /**
     * @param Request             $request
     *
     * @param FileServiceProvider $provider
     *
     * @return \Illuminate\Http\RedirectResponse
     */
    public function uploadFile(Request $request, FileServiceProvider $provider)
    {
        $destinationPath = $request->get('path');
        $request->data->move($destinationPath, $request->data->getClientOriginalName());

        // Add to database
        $model             = new UploadedFile();
        $model->user_id    = Auth::user()->id;
        $model->path       = UploadedFile::cleanPath($destinationPath.$provider->getOSSeperator().$request->data->getClientOriginalName());
        $model->updated_at = Carbon::now();
        $model->created_at = Carbon::now();
        $model->mime_type  = $request->data->getClientMimeType();
        $model->save();

        return redirect()->back();
    }

    /**
     * @param GetFileRequest $request
     *
     * @return Application|ResponseFactory|Response|\Symfony\Component\HttpFoundation\BinaryFileResponse
     */
    public function downloadFileAPI(GetFileRequest $request)
    {
        try {
            $request->verifyToken();
        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }

        return \response()->download($request->path);
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

            return response("successfully created directory ".$file->getPath(), 200);

        } catch (\Exception $e) {
            return response($e->getMessage(), 400);
        }
    }
}
