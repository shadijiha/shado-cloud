<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
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
        $tokens     = explode("\\", $this->path);
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

    public function __construct(\SplFileInfo $file)
    {
        $this->name      = $file->getFilename();
        $this->extension = $file->getExtension();
        $this->path      = $file->getRealPath();
        $this->native    = $file;
    }

    /**
     * @return string
     */
    public function getRelativePath(): string
    {
        return str_replace("\\", "/", str_replace(FileFetcherController::getCloudPath()."\\", "", $this->path));
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
        $temp = new DirectoryStruct($this->CLOUD_PATH);
        return response(["data" => $temp]);
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
        return response(["data" => new DirectoryStruct($request->get("path"))]);
    }

    /**
     * @return string
     */
    public static function getCloudPath(): string
    {
        return str_replace("\\\\", "\\", (new FileFetcherController())->CLOUD_PATH);
    }
}
