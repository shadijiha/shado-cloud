<?php

use App\Http\Controllers\api\v2\AuthAPIController;
use App\Http\Controllers\APIController;
use App\Http\Controllers\APITokenController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\SaveController;
use App\Http\Controllers\UpdateController;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Web Routes
|--------------------------------------------------------------------------
|
| Here is where you can register web routes for your application. These
| routes are loaded by the RouteServiceProvider within a group which
| contains the "web" middleware group. Now create something great!
|
*/

Auth::routes(/*['register' => false]*/);

Route::middleware('auth')->group(function () {

    Route::get('/', [HomeController::class, 'index'])->name('index');
    Route::get("/settings", [HomeController::class, 'settings'])->name('settings');

    Route::get("/search", "App\Http\Controllers\SearchController@search")->name("search");
    Route::get("/update", [UpdateController::class, "update"])->name("update");
    Route::post("/uploadfile", [APIController::class, 'uploadFile'])->name("upload_file");
    Route::post("/save", [SaveController::class, "save"])->name("save");
    Route::post("/generate", [APITokenController::class, "generate"])->name("generate");
    Route::post("/deleteKey", [APITokenController::class, "delete"])->name("deleteKey");

    Route::post("/createDir", [APIController::class, 'createDirectoryAPI'])->name("createDir");
    Route::post("/unzip", [SaveController::class, 'unzipFile']);
});

Route::prefix('api')->group(function () {

    Route::get("/dir", [APIController::class, 'indexDirectoriesAPI']);
    Route::get("/tree", [APIController::class, 'getTreeAPI']);

    Route::get("", [APIController::class, 'getFileAPI'])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("", [APIController::class, 'saveFileAPI'])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::get("/info", [APIController::class, 'infoFileAPI']);
    Route::get("/delete", [APIController::class, 'deleteFileAPI']);
    Route::get("/rename", [APIController::class, 'renameFileAPI']);
    Route::get("/download", [APIController::class, 'downloadFileAPI']);
    Route::get("/copytodrive", [APIController::class, 'copyFileToDriveAPI']);
});

Route::prefix("api/v2")->group(function () {
    Route::post("/login", [AuthAPIController::class, "login"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::get("/rootdirectory", [App\Http\Controllers\api\v2\APIController::class, "getRootDirectory"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::get("/files", [App\Http\Controllers\api\v2\APIController::class, "getFilesInDirectory"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::get("/info", [App\Http\Controllers\api\v2\APIController::class, "getFilesInfo"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/upload", [App\Http\Controllers\api\v2\APIController::class, "uploadFile"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/createDir", [App\Http\Controllers\api\v2\APIController::class, "createDirectory"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/createFile", [App\Http\Controllers\api\v2\APIController::class, "createFile"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/unzip", [App\Http\Controllers\api\v2\APIController::class, "unzipFile"])->withoutMiddleware(VerifyCsrfToken ::class);

    Route::get("/ping", [AuthAPIController::class, "ping"])->withoutMiddleware(VerifyCsrfToken ::class);

    Route::get("/apikeys", [App\Http\Controllers\api\v2\APIController::class, "getAPIKeys"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/deletekey", [App\Http\Controllers\api\v2\APIController::class, "deleteAPIKey"])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::post("/generatekey", [App\Http\Controllers\api\v2\APIController::class, "generateAPIKey"])->withoutMiddleware(VerifyCsrfToken ::class);
});
