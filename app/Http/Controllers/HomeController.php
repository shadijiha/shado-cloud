<?php

namespace App\Http\Controllers;

use App\Http\structs\FileStruct;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Support\Renderable;
use Illuminate\Contracts\View\Factory;
use Illuminate\Contracts\View\View;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;

class HomeController extends Controller
{
    /**
     * Create a new controller instance.
     *
     * @return void
     */
    public function __construct()
    {
        $this->middleware('auth');
    }

    /**
     * Show the application dashboard.
     *
     * @param Request       $request
     * @param APIController $controller
     *
     * @return Renderable|void
     */
    public function index(Request $request, APIController $controller)
    {
        // See if it is a file or not (to preview)
        $path = $request->get("path");
        if (File::isDirectory($path) || $path == "" || $path == null) {

            $data = $controller->indexDirectories($path);
            return view('home')->with(
                [
                    "files" => $data,
                    "path"  => $path ?? env("CLOUD_FILES_PATH"),
                    "key"   => $request->get("key")]);

        } else {
            if (File::exists($path)) {
                //TODO: change this to use --> mime_content_type($path)
                $file_struct = new FileStruct(new \SplFileInfo($path));

                if ($file_struct->isImage() || $file_struct->isVideo() || $file_struct->isPDF()) {
                    return view('preview_media')->with([
                        "file" => $file_struct,
                        "path" => $path,
                    ]);
                }

                return view('preview')->with([
                    "file" => $file_struct,
                    "path" => null
                ]);
            } else
                return abort(404);
        }
    }

    /**
     * @param Request $request
     *
     * @return Application|Factory|View
     */
    public function settings(Request $request)
    {
        return view('settings')->with(
            ['tokens' => Auth::user()->apiTokens]);
    }
}
