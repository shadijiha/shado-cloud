<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
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
     * @param Request               $request
     * @param FileFetcherController $controller
     *
     * @return \Illuminate\Contracts\Support\Renderable|void
     */
    public function index(Request $request, FileFetcherController $controller)
    {
        // See if it is a file or not (to preview)
        $path = $request->get("path");
        if (File::isDirectory($path) || $path == "" || $path == null) {

            $data = $controller->indexDirectories($path);
            return view('home')->with(
                ["files" => $data]);

        } else {
            if (File::exists($path))
                return view('preview')->with([
                    "file" => new FileStruct(new \SplFileInfo($path))
                ]);
            else
                return abort(404);
        }
    }
}
