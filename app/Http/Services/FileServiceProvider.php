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
        if (Auth::user())
            $this->cloud_path = env("CLOUD_FILES_PATH").$this->getOSSeperator().Auth::user()->email ?? env("CLOUD_FILES_PATH");
        else
            $this->cloud_path = env("CLOUD_FILES_PATH");
    }

    /**
     * Creates or Updates an existing file with the given path.
     * Inserts the given content to the file.
     * After that, it attempts to update the uploaded_files database
     *
     * @param string $path
     * @param string $content
     * @param bool   $append
     */
    public function updateOrCreateFile(string $path, string $content, bool $append = false): void
    {
        // Replace the word '{NEW_LINE}' by a \n because for some reason \n isn't working from C#
        $content = str_replace("!CMD_NEW_LINE!", "\n", $content);

        if (File::exists($path)) {
            $mode   = $append ? "a" : "w";
            $stream = fopen($path, $mode);
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
        return new FileStruct(new \SplFileInfo($path));
    }

    /**
     * @param string $path
     *
     * @throws \Exception
     */
    public function deleteFile(string $path)
    {
        // Verify that that path you want to modify is inside the parent cloud directory
        $this->verifyIfPermissionToModify($path);

        if (File::isDirectory($path))
            File::deleteDirectory($path);
        else
            File::delete($path);

        // After deletion, delete from the database
        $temp = UploadedFile::getFromPath($path);
        if ($temp)
            $temp->delete();    // To avoid call on null
    }

    public function renameFile(string $path, string $newName)
    {
        // Verify that that path you want to modify is inside the parent cloud directory
        $this->verifyIfPermissionToModify($path);

        // Get the uploaded file from the database
        $uploaded_file = UploadedFile::getFromPath($path);
        $native        = new \SplFileInfo($path);

        // Get the seperator
        $seperator = $this->getOSSeperator();

        if (File::isDirectory($path)) {
            $result = rename($path, $native->getPath().$seperator.$newName);
            if (!$result)
                throw new \Exception("Could not rename the folder");

        } else {
            File::move($path, $native->getPath().$seperator.$newName);
        }

        if ($uploaded_file) {
            $uploaded_file->path = $native->getPath().$seperator.$newName;
            $uploaded_file->save();
        } else {
            // If it is not in the database then add it
            $uploaded_file             = new UploadedFile();
            $uploaded_file->user_id    = Auth::user() ? Auth::user()->id : null;
            $uploaded_file->path       = $native->getPath().$seperator.$newName;
            $uploaded_file->mime_type  = (new FileStruct(new \SplFileInfo($native->getPath().$seperator.$newName)))->getMimeType();
            $uploaded_file->updated_at = Carbon::now();
            $uploaded_file->created_at = Carbon::now();
            $uploaded_file->save();
        }
    }

    public function copyFile(string $path, string $destination)
    {
        $fileName = basename($path);
        file_put_contents($destination.$this->getOSSeperator().$fileName, file_get_contents($path));
    }

    /**
     * @param string $path
     */
    public function unzipFile(string $path)
    {
        $struct  = new \SplFileInfo($path);
        $newPath = $struct->getPath();

        $zip = new \ZipArchive();
        $zip->open($path);
        $zip->extractTo($newPath);
        $zip->close();
    }

    public function getOSSeperator(): string
    {
        return PHP_OS == "Windows" || PHP_OS == "WINNT" ? "\\" : "/";
    }

    public function getCloudPath(): string
    {
        return $this->cloud_path;
    }

    /**
     * @param string $path
     *
     * @throws \Exception
     */
    public function verifyIfPermissionToModify(string $path)
    {
        if (!Str::contains(UploadedFile::cleanPath($path), UploadedFile::cleanPath($this->getCloudPath()))) {
            abort(401, "You do not have permission to modify this path");
            //throw new \Exception("You do not have permission to modify this path");
        }
    }

    public function ownsDirectory(User $user, string $path): bool
    {
        $users_cloud_path = env("CLOUD_FILES_PATH").$this->getOSSeperator().$user->email ?? env("CLOUD_FILES_PATH");
        $users_cloud_path = UploadedFile::cleanPath($users_cloud_path);
        return Str::contains(UploadedFile::cleanPath($path), $users_cloud_path);
    }

    public static function getOwnerOfDirectory(string $path): ?User
    {
        if ($path == null)
            return null;

        $seperator = new FileServiceProvider();
        $tokens    = explode($seperator->getOSSeperator(), UploadedFile::cleanPath($path));

        // Get the email from the tokens
        foreach ($tokens as $token)
            if (Str::contains($token, "@")) {
                $email = $token;
                break;
            }

        return User::where("email", $email)->first();
    }
}
