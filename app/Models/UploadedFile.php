<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class UploadedFile extends Model
{
    use HasFactory;

    protected $table = "uploaded_files";

    public static function getFromPath(string $path)
    {
        return UploadedFile::where("path", $path)->first();
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
        return preg_replace('/\\\\{2,}/', '\\', $path);
    }

    public function user()
    {
        $this->belongsTo(User::class);
    }
}
