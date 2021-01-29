<?php

namespace App\Http\structs;

use App\Http\Controllers\FileFetcherController;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

class FileStruct
{
    public $name;
    public $extension;
    public $path;
    public $native;
    public $url;

    public $size;

    const IMAGE_EXT = ["jpg", "png", "gif", "jpeg", "apng", "svg", "tiff", ".bmp", "eps"];

    public function __construct(\SplFileInfo $file)
    {
        $this->name      = $file->getFilename();
        $this->extension = $file->getExtension();
        $this->path      = $file->getRealPath();
        $this->native    = $file;

        $token = null;
        if (Auth::user()) {
            $token = Auth::user()->validAPITokens()->first();
        }
        $token     = $token == null ? "{YOUR_API_KEY}" : $token->key;
        $this->url = url("/")."/api?key=$token&path=$this->path";

        // Properties
        $this->size = $file->getSize();
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

    /**
     * Determins if the file is an image based on its extension
     * @return bool
     */
    public function isImage(): bool
    {
        foreach (self::IMAGE_EXT as $ext) {
            if (Str::lower($this->native->getExtension()) == $ext) {
                return true;
            }
        }
        return false;
    }
}
