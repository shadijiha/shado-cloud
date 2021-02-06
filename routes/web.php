<?php

use App\Http\Controllers\APITokenController;
use App\Http\Controllers\FileFetcherController;
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

Auth::routes(['register' => false]);

Route::middleware('auth')->group(function () {

    Route::get('/', [HomeController::class, 'index'])->name('index');
    Route::get("/settings", [HomeController::class, 'settings'])->name('settings');

    Route::get("/search", "App\Http\Controllers\SearchController@search")->name("search");
    Route::get("/update", [UpdateController::class, "update"])->name("update");
    Route::post("/uploadfile", [FileFetcherController::class, 'uploadFile'])->name("upload_file");
    Route::post("/save", [SaveController::class, "save"])->name("save");
    Route::post("/generate", [APITokenController::class, "generate"])->name("generate");
    Route::post("/deleteKey", [APITokenController::class, "delete"])->name("deleteKey");

    Route::post("/createDir", [FileFetcherController::class, 'createDirectoryAPI'])->name("createDir");
});

Route::prefix('api')->group(function () {

    Route::get("/dir", [FileFetcherController::class, 'indexDirectoriesAPI']);
    Route::get("/tree", [FileFetcherController::class, 'getTreeAPI']);

    Route::get("", [FileFetcherController::class, 'getFileAPI']);
    Route::post("", [FileFetcherController::class, 'saveFileAPI'])->withoutMiddleware(VerifyCsrfToken ::class);
    Route::get("/info", [FileFetcherController::class, 'infoFileAPI']);
    Route::get("/delete", [FileFetcherController::class, 'deleteFileAPI']);
    Route::get("/rename", [FileFetcherController::class, 'renameFileAPI']);
});


