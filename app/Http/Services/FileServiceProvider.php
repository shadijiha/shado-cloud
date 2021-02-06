<?php namespace App\Http\Services;

use App\Http\structs\FileStruct;
use App\Models\UploadedFile;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class FileServiceProvider
{
    private $cloud_path = "";

    public function __construct()
    {
        $this->cloud_path = env("CLOUD_FILES_PATH");
    }

    /**
     * Creates or Updates an existing file with the given path.
     * Inserts the given content to the file.
     * After that, it attempts to update the uploaded_files database
     *
     * @param string $path
     * @param string $content
     */
    public function updateOrCreateFile(string $path, string $content): void
    {
        if (File::exists($path)) {
            $stream = fopen($path, "w");
            fwrite($stream, $content);
            fclose($stream);
        } else {
            $file = new \SplFileInfo($path);
            File::makeDirectory($file->getPath(), 0777, true, true);

            $stream = fopen($path, "w");
            fwrite($stream, $content);
            fclose($stream);
        }

        // After the file has been modified, Updated the updated_at column
        $db_struct = UploadedFile::getFromPath($path);
        if ($db_struct) {
            $db_struct->updated_at = Carbon::now();
            $db_struct->save();
        } else {
            // If it is not there, then attempt to insert it
            $db_struct             = new UploadedFile();
            $db_struct->path       = UploadedFile::cleanPath($path);
            $db_struct->mime_type  = "text/plain";
            $db_struct->user_id    = Auth::user() ? Auth::user()->id : User::all()->first()->id;
            $db_struct->created_at = Carbon::now();
            $db_struct->updated_at = Carbon::now();
            $db_struct->save();
        }
    }

    public function getFile(string $path): FileStruct
    {
        //$buffer = file_get_contents($path);

        // See if the file is a image or not
        return new FileStruct(new \SplFileInfo($path));
    }

    /**
     * @param string $path
     *
     * @throws \Exception
     */
    public function deleteFile(string $path)
    {
        // Verify that that path you want to delete is inside the parent cloud directory
        if (!Str::contains((new \SplFileInfo($path))->getRealPath(), (new \SplFileInfo($this->cloud_path))->getRealPath())) {
            throw new \Exception("You do not have permission to modify this path");
        }
        if (File::isDirectory($path))
            File::deleteDirectory($path);
        else
            File::delete($path);

        // After deletion, delete from the database
        $temp = UploadedFile::getFromPath($path);
        if ($temp)
            $temp->delete();    // To avoid call on null
    }
}
