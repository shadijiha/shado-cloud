<?php

namespace App\Models;

use App\Http\Services\FileServiceProvider;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * Class UploadedFile
 * @package App\Models
 * @mixin Builder
 */
class UploadedFile extends Model
{
    use HasFactory;

    protected $table = "uploaded_files";

    public static function getFromPath(string $path)
    {
        return UploadedFile::where("path", UploadedFile::cleanPath($path))->first();
    }

    public static function getFromTempURL(string $url)
    {
        return UploadedFile::where("temporary_url", UploadedFile::cleanPath($url))->first();
    }

    /**
     * Removes unecessary slashes
     *
     * @param string $path
     *
     * @return string
     */
    public static function cleanPath(string $path): string
    {
        $temp = preg_replace('/\\\\{2,}/', '\\', $path);
        $temp = preg_replace('/\/+/i', "/", $temp);
        // Remove a / followed by \
        $temp = str_replace("/\\", "/", $temp);
        $temp = str_replace("\\", (new FileServiceProvider())->getOSSeperator(), $temp);
        $temp = str_replace("/", (new FileServiceProvider())->getOSSeperator(), $temp);

        return $temp;
    }

    public function user()
    {
        $this->belongsTo(User::class);
    }
}
