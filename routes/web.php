<?php

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

Auth::routes();

Route::middleware('auth')->group(function () {

    Route::get('/', [App\Http\Controllers\HomeController::class, 'index'])->name('index');

    Route::get("/search", "App\Http\Controllers\SearchController@search");

    // TODO: Move API function outside of middleware, require api key instead
    Route::get("/dir", [App\Http\Controllers\FileFetcherController::class, 'indexDirectoriesAPI']);
    Route::get("/tree", [App\Http\Controllers\FileFetcherController::class, 'getTreeAPI']);
});


