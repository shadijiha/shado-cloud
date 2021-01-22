<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\Process\Exception\ProcessFailedException;
use Symfony\Component\Process\Process;

class UpdateController extends Controller
{
    const SUCCESS = 0;
    const ERROR = 1;

    private $output = "";
    private $status = UpdateController::SUCCESS;

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function update(Request $request)
    {
        $this->output = "";
        $message      = "";

        try {
            $base_command = "cd ".base_path();

            // Pull from github;
            //exec("$base_command && git pull", $this->output, $this->status);
            //dd($this->output);

            $process = new Process(["git", "pull"]);
            $process->run();

            if (!$process->isSuccessful()) {
                $this->status = UpdateController::ERROR;
                $this->output = $process->getOutput();
            }

            // Install composer dependencies
            //exec("$base_command && composer install", $this->output, $this->status);

            // Install npm dependencies
            //exec("$base_command && npm install", $this->output, $this->status);

            // Run npm production
            //exec("$base_command && npm run prod", $this->output, $this->status);

        } catch (ProcessFailedException  $e) {
            $status  = UpdateController::ERROR;
            $message = $e->getMessage();
        }

        return response([
            "status"  => $this->status,
            "output"  => $this->output,
            "message" => $message
        ]);
    }
}
