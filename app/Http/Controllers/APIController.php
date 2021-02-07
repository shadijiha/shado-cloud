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
use App\Models\UploadedFile;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
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
        } catch (\Exception $e) {
            return \response(["code" => 400, "message" => $e->getMessage()]);
        }

        return response(["data" => new DirectoryStruct($provider->getCloudPath())]);
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
            return \response(["code" => 400, "message" => $e->getMessage()]);
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

    public function infoFileAPI(GetFileRequest $request, FileServiceProvider $provider)
    {
        $path = $request->path;

        // Verify token
        try {
            $request->verifyToken();

            // Get database info
            $struct = $provider->getFile($path);
        } catch (\Exception $e) {
            return \response([
                "code"    => 400,
                "message" => $e->getMessage()
            ]);
        }

        return [
            "code"  => 200,
            "props" => $struct->getProps()];
    }

    public function renameFileAPI(RenameFileRequest $request, FileServiceProvider $provider)
    {
        $path    = $request->path;
        $newname = $request->newname;

        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return \response([
                "code"    => 400,
                "message" => $e->getMessage()
            ]);
        }

        // Rename the file
        try {
            $provider->renameFile($path, $newname);
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

    public function copyFileToDriveAPI(MoveToDriveRequest $request, FileServiceProvider $provider)
    {
        try {
            $request->verifyToken(true);
        } catch (\Exception $e) {
            return \response([
                "code"    => 400,
                "message" => $e->getMessage()
            ]);
        }

        $provider->copyFile($request->url, $request->path);

        return \response([
            "code"    => 200,
            "message" => ""
        ]);
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
            return response(["code" => 400, "message" => $e->getMessage()]);
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
}
