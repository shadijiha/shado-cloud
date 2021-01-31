<?php

namespace App\Http\structs;

use App\Http\Controllers\FileFetcherController;
use App\Models\UploadedFile;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;
use Symfony\Component\Mime\MimeTypes;

class FileStruct
{
    public $name;
    public $extension;
    public $path;
    public $native;
    public $url;
    public $size;

    const IMAGE_EXT = ["jpg", "png", "gif", "jpeg", "apng", "svg", "tiff", ".bmp", "eps"];
    const VIDEO_EXT = ["mp4", "ogg", "mov", "wmv", "flv", "avi", "WebM"];
    const PDF_EXT = ["pdf"];

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
     * @return UploadedFile
     */
    public function getUploadedFile(): UploadedFile
    {
        return UploadedFile::where("path", UploadedFile::cleanPath($this->native->getRealPath()))->first();
    }

    /**
     * Attempts to find the Mime from that database.
     * If not found it will attempt to guess the Mime type
     *
     * @return string
     */
    public function getMimeType(): string
    {
        $uploaded_file = UploadedFile::getFromPath($this->native->getRealPath());
        $mime          = MimeTypes::getDefault()->guessMimeType($this->native->getRealPath());
        if ($uploaded_file) {
            $mime = $uploaded_file->mime_type;
        }

        return $mime;
    }

    /**
     * Determins if the file is an image based on its extension
     * @return bool
     */
    public function isImage(): bool
    {
        return $this->match(self::IMAGE_EXT) || Str::contains($this->getMimeType(), ["image", "img"]);
    }

    public function isVideo(): bool
    {
        return $this->match(self::VIDEO_EXT) || Str::contains($this->getMimeType(), "video");
    }

    public function isPDF(): bool
    {
        return $this->match(self::PDF_EXT) || Str::contains($this->getMimeType(), "pdf");
    }

    /**
     * @param array $arr
     *
     * @return bool
     */
    private function match(array $arr): bool
    {
        foreach ($arr as $ext) {
            if (Str::lower($this->native->getExtension()) == Str::lower($ext)) {
                return true;
            }
        }
        return false;
    }
}
