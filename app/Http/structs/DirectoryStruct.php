<?php

namespace App\Http\structs;

use App\Http\Services\FileServiceProvider;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

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
            array_push($this->files, new \App\Http\structs\FileStruct($file));
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
        $provider = new FileServiceProvider();
        $temp     = str_replace("\\", "/", str_replace($provider->getCloudPath()."\\", "", $this->path));
        return $temp;
    }
}
